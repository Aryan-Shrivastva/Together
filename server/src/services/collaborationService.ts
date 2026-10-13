import { watch, type FSWatcher } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import type * as Y from 'yjs';

import { env } from '../config/env.js';
import { HttpError } from '../errors/httpError.js';
import { fileService } from './fileService.js';
import { workspaceService } from './workspaceService.js';

type DocumentTarget = {
  workspaceId: string;
  path: string;
};

type PersistenceFailureListener = (target: DocumentTarget) => void;

type ActiveDocument = {
  target: DocumentTarget;
  watcher: FSWatcher;
  persistTimer: NodeJS.Timeout | undefined;
  unloadTimer: NodeJS.Timeout | undefined;
};

type SharedDocument = Y.Doc & {
  name: string;
  conns: Map<unknown, Set<number>>;
};

const require = createRequire(import.meta.url);
const yWebsocketUtilitiesPath = resolve(
  dirname(require.resolve('y-websocket')),
  '..',
  'bin',
  'utils.js',
);
const yWebsocketUtils = require(yWebsocketUtilitiesPath) as {
  docs: Map<string, SharedDocument>;
  getYDoc: (documentName: string) => SharedDocument;
};
const { docs } = yWebsocketUtils;

export class CollaborationService {
  private readonly activeDocuments = new Map<string, ActiveDocument>();
  private persistenceFailureListener: PersistenceFailureListener | undefined;

  setPersistenceFailureListener(listener: PersistenceFailureListener | undefined): void {
    this.persistenceFailureListener = listener;
  }

  documentName(target: DocumentTarget): string {
    return `${target.workspaceId}:${encodeURIComponent(target.path)}`;
  }

  parseDocumentName(documentName: string): DocumentTarget | null {
    const separator = documentName.indexOf(':');
    if (separator <= 0) {
      return null;
    }

    try {
      return {
        workspaceId: documentName.slice(0, separator),
        path: decodeURIComponent(documentName.slice(separator + 1)),
      };
    } catch {
      return null;
    }
  }

  scheduleUnload(documentName: string): void {
    const active = this.activeDocuments.get(documentName);
    const document = docs.get(documentName);
    if (!active || !document || document.conns.size > 0 || active.unloadTimer) {
      return;
    }

    active.unloadTimer = setTimeout(() => {
      const current = docs.get(documentName);
      if (!current || current.conns.size > 0) {
        return;
      }

      void this.flushDocument(documentName)
        .catch(() => this.logPersistenceFailure(documentName))
        .finally(() => this.disposeDocument(documentName));
    }, env.COLLABORATION_DOC_UNLOAD_MS);
  }

  cancelScheduledUnload(documentName: string): void {
    const active = this.activeDocuments.get(documentName);
    if (active?.unloadTimer) {
      clearTimeout(active.unloadTimer);
      active.unloadTimer = undefined;
    }
  }

  async flushAll(): Promise<void> {
    const documentNames = [...this.activeDocuments.keys()];
    const results = await Promise.allSettled(
      documentNames.map((documentName) => this.flushDocument(documentName)),
    );

    results.forEach((result, index) => {
      const documentName = documentNames[index];
      if (result.status === 'rejected' && documentName) {
        this.logPersistenceFailure(documentName);
      }
    });
  }

  async flushWorkspace(workspaceId: string): Promise<void> {
    const documentNames = [...this.activeDocuments.entries()]
      .filter(([, active]) => active.target.workspaceId === workspaceId)
      .map(([documentName]) => documentName);
    const results = await Promise.allSettled(
      documentNames.map((documentName) => this.flushDocument(documentName)),
    );

    if (results.some((result) => result.status === 'rejected')) {
      results.forEach((result, index) => {
        const documentName = documentNames[index];
        if (result.status === 'rejected' && documentName) {
          this.logPersistenceFailure(documentName);
        }
      });
      throw new HttpError(
        503,
        'Collaborative edits could not be saved to the workspace. Try again before using Git.',
      );
    }
  }

  async reloadWorkspace(workspaceId: string): Promise<void> {
    await Promise.all(
      [...this.activeDocuments.entries()]
        .filter(([, active]) => active.target.workspaceId === workspaceId)
        .map(([documentName]) => this.reloadFromDisk(documentName)),
    );
  }

  async prepareDocument(documentName: string): Promise<void> {
    const document = yWebsocketUtils.getYDoc(documentName);
    if (!this.activeDocuments.has(documentName)) {
      await this.initialize(document);
    }
  }

  private async initialize(document: SharedDocument): Promise<void> {
    const target = this.parseDocumentName(document.name);
    if (!target) {
      throw new Error('Invalid collaborative document.');
    }

    const diskFile = await fileService.readTextFile(target.workspaceId, target.path);
    const sharedText = document.getText('content');
    document.transact(() => sharedText.insert(0, diskFile.content), 'disk-initialization');

    const absolutePath = await workspaceService.resolveFilePath(target.workspaceId, target.path);
    const active: ActiveDocument = {
      target,
      watcher: watch(absolutePath, { persistent: false }, () => {
        void this.reloadFromDisk(document.name);
      }),
      persistTimer: undefined,
      unloadTimer: undefined,
    };
    this.activeDocuments.set(document.name, active);
    document.on('update', () => this.schedulePersistence(document.name));
  }

  private schedulePersistence(documentName: string): void {
    const active = this.activeDocuments.get(documentName);
    if (!active) {
      return;
    }

    if (active.persistTimer) {
      clearTimeout(active.persistTimer);
    }
    active.persistTimer = setTimeout(() => {
      active.persistTimer = undefined;
      void this.flushDocument(documentName).catch(() => this.logPersistenceFailure(documentName));
    }, env.COLLABORATION_PERSIST_DEBOUNCE_MS);
  }

  private async reloadFromDisk(documentName: string): Promise<void> {
    const active = this.activeDocuments.get(documentName);
    const document = docs.get(documentName);
    if (!active || !document) {
      return;
    }

    try {
      const diskFile = await fileService.readTextFile(
        active.target.workspaceId,
        active.target.path,
      );
      const sharedText = document.getText('content');
      if (sharedText.toString() !== diskFile.content) {
        document.transact(() => {
          sharedText.delete(0, sharedText.length);
          sharedText.insert(0, diskFile.content);
        }, 'disk-reload');
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        const target = active.target;
        console.error('Failed to reload a collaborative document from disk.', {
          workspaceId: target.workspaceId,
          path: target.path,
        });
      }
      // A deleted or moved file is handled by the file API; keep the in-memory document intact.
    }
  }

  private async flushDocument(documentName: string): Promise<void> {
    const active = this.activeDocuments.get(documentName);
    const document = docs.get(documentName);
    if (!active || !document) {
      return;
    }

    await fileService.writeTextFile(
      active.target.workspaceId,
      active.target.path,
      document.getText('content').toString(),
    );
  }

  private logPersistenceFailure(documentName: string): void {
    const target = this.parseDocumentName(documentName);
    console.error(
      'Failed to persist a collaborative document.',
      target ? { workspaceId: target.workspaceId, path: target.path } : undefined,
    );
    if (target) {
      this.persistenceFailureListener?.(target);
    }
  }

  private disposeDocument(documentName: string): void {
    const active = this.activeDocuments.get(documentName);
    const document = docs.get(documentName);
    if (!active || !document || document.conns.size > 0) {
      return;
    }

    if (active.persistTimer) {
      clearTimeout(active.persistTimer);
    }
    if (active.unloadTimer) {
      clearTimeout(active.unloadTimer);
    }
    active.watcher.close();
    document.destroy();
    docs.delete(documentName);
    this.activeDocuments.delete(documentName);
  }
}

export const collaborationService = new CollaborationService();
