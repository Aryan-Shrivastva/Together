import { FalkorDB, type Graph } from 'falkordb';
import { simpleGit } from 'simple-git';

import { env } from '../config/env.js';
import { prisma } from '../db/client.js';
import { HttpError } from '../errors/httpError.js';
import { fileService, type FileTreeNode } from './fileService.js';
import type { BrainAnswer, BrainSource } from './brainService.js';
import { workspaceService } from './workspaceService.js';

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  'vendor',
  '.git',
]);

const TEXT_EXTENSIONS = new Set([
  'md',
  'txt',
  'json',
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'css',
  'html',
  'yml',
  'yaml',
  'toml',
  'go',
  'rs',
  'java',
  'rb',
  'prisma',
  'sql',
  'xml',
  'sh',
  'c',
  'h',
  'cpp',
  'cs',
  'php',
  'vue',
  'svelte',
]);

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'what',
  'who',
  'how',
  'does',
  'did',
  'are',
  'was',
  'were',
  'can',
  'you',
  'our',
  'your',
  'about',
  'where',
  'when',
  'which',
  'into',
  'have',
  'has',
  'not',
]);

const GRAPH_FRESH_MS = 20_000;
const MAX_DOCUMENTS = 60;
const MAX_COMMITS = 20;

type GraphRow = Record<string, string>;

let connection: Promise<FalkorDB> | null = null;
const syncs = new Map<string, Promise<void>>();

function graphName(workspaceId: string): string {
  return `together_${workspaceId.replaceAll('-', '')}`;
}

function getConnection(): Promise<FalkorDB> {
  connection ??= FalkorDB.connect({
    socket: {
      host: env.FALKORDB_HOST,
      port: env.FALKORDB_PORT,
    },
  }).catch((error: unknown) => {
    connection = null;
    throw error;
  });

  return connection;
}

function isUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return (
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('socket') ||
    message.includes('connect')
  );
}

function asGraphError(error: unknown): never {
  if (error instanceof HttpError) {
    throw error;
  }

  if (isUnavailable(error)) {
    throw new HttpError(503, 'FalkorDB is not running, so the workspace graph cannot answer yet.');
  }

  throw error;
}

type CypherValue =
  string | number | boolean | null | CypherValue[] | { [key: string]: CypherValue };

async function queryGraph(
  workspaceId: string,
  cypher: string,
  params: { [key: string]: CypherValue },
) {
  try {
    const database = await getConnection();
    return await database.selectGraph(graphName(workspaceId)).query(cypher, {
      params: params as never,
    });
  } catch (error) {
    asGraphError(error);
  }
}

function rowsFrom(result: { headers?: string[]; data?: unknown } | undefined): GraphRow[] {
  if (!result?.headers || !Array.isArray(result.data)) {
    return [];
  }

  return result.data.map((row) => {
    const values = Array.isArray(row) ? row : [];
    const record: GraphRow = {};
    result.headers?.forEach((header, index) => {
      const value = values[index];
      record[header] = value == null ? '' : String(value);
    });
    return record;
  });
}

function termsFromQuestion(question: string): string[] {
  return [
    ...new Set(
      question
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/)
        .filter((term) => term.length > 2 && !STOP_WORDS.has(term)),
    ),
  ].slice(0, 8);
}

function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function flattenFiles(nodes: FileTreeNode[], files: string[]): void {
  for (const node of nodes) {
    if (node.kind === 'directory') {
      if (!SKIPPED_DIRECTORIES.has(node.name) && node.children) {
        flattenFiles(node.children, files);
      }
      continue;
    }

    if (TEXT_EXTENSIONS.has(extensionOf(node.path))) {
      files.push(node.path);
    }
  }
}

function clip(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

async function readDocuments(workspaceId: string) {
  const files: string[] = [];
  flattenFiles(await fileService.listTree(workspaceId), files);
  const documents: Array<{ path: string; name: string; excerpt: string }> = [];

  for (const path of files.slice(0, MAX_DOCUMENTS)) {
    const name = path.split('/').pop() ?? path;
    try {
      const file = await fileService.readTextFile(workspaceId, path);
      documents.push({ path, name, excerpt: clip(file.content, 500) });
    } catch (error) {
      if (error instanceof HttpError) {
        documents.push({ path, name, excerpt: '' });
        continue;
      }
      throw error;
    }
  }

  return documents;
}

async function readDecisions(workspaceId: string, documents: Array<{ path: string }>) {
  const knownPaths = new Set(documents.map((document) => document.path));
  try {
    const git = simpleGit({ baseDir: workspaceService.getRoot(workspaceId) });
    const log = await git.log({ maxCount: MAX_COMMITS });
    const decisions = [];

    for (const entry of log.all) {
      const names = await git.raw(['diff-tree', '--no-commit-id', '--name-only', '-r', entry.hash]);
      const files = names
        .split('\n')
        .map((path) => path.trim())
        .filter((path) => knownPaths.has(path));
      decisions.push({
        sha: entry.hash,
        message: clip(entry.message, 240),
        authorName: entry.author_name,
        files,
      });
    }

    return decisions;
  } catch {
    return [];
  }
}

async function syncWorkspace(workspaceId: string): Promise<void> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      name: true,
      repoFullName: true,
      status: true,
      members: {
        select: { role: true, user: { select: { id: true, username: true } } },
        orderBy: { joinedAt: 'asc' },
      },
    },
  });

  if (!workspace) {
    throw new HttpError(404, 'Workspace not found.');
  }

  if (workspace.status !== 'READY') {
    throw new HttpError(409, 'This workspace is not ready to search yet.');
  }

  const database = await getConnection();
  const graph = database.selectGraph(graphName(workspaceId));
  let builtAt = 0;

  try {
    const existing = await graph.roQuery(
      'MATCH (project:Project {id: $workspaceId}) RETURN project.builtAt AS builtAt',
      { params: { workspaceId } },
    );
    builtAt = Number(rowsFrom(existing)[0]?.builtAt ?? 0);
  } catch (error) {
    if (error instanceof HttpError || isUnavailable(error)) {
      asGraphError(error);
    }
  }

  if (builtAt > 0 && Date.now() - builtAt < GRAPH_FRESH_MS) {
    return;
  }

  const rememberedAnswers = await readSavedAnswers(graph);

  try {
    await graph.delete();
  } catch (error) {
    if (isUnavailable(error)) {
      asGraphError(error);
    }
  }

  const people = workspace.members.map((member) => ({
    id: member.user.id,
    username: member.user.username,
    role: member.role,
  }));
  const documents = await readDocuments(workspaceId);
  const decisions = await readDecisions(workspaceId, documents);
  const messages = await prisma.chatMessage.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true,
      content: true,
      createdAt: true,
      user: { select: { id: true, username: true } },
    },
  });

  await graph.query(
    `CREATE (:Project {id: $workspaceId, name: $name, repo: $repo, builtAt: $builtAt})`,
    {
      params: {
        workspaceId,
        name: workspace.name,
        repo: workspace.repoFullName,
        builtAt: Date.now(),
      },
    },
  );

  if (people.length > 0) {
    await graph.query(
      `UNWIND $people AS person
       CREATE (p:Person {id: person.id, username: person.username})
       WITH p, person
       MATCH (project:Project {id: $workspaceId})
       CREATE (p)-[:MEMBER_OF {role: person.role}]->(project)`,
      { params: { people, workspaceId } },
    );
    const owners = people.filter((person) => person.role === 'OWNER');
    if (owners.length > 0) {
      await graph.query(
        `UNWIND $owners AS person
         MATCH (p:Person {id: person.id}), (project:Project {id: $workspaceId})
         CREATE (p)-[:OWNS]->(project)`,
        { params: { owners, workspaceId } },
      );
    }
  }

  if (documents.length > 0) {
    await graph.query(
      `UNWIND $documents AS document
       CREATE (d:Document {path: document.path, name: document.name, excerpt: document.excerpt})
       WITH d
       MATCH (project:Project {id: $workspaceId})
       CREATE (d)-[:PART_OF]->(project)`,
      { params: { documents, workspaceId } },
    );
  }

  if (decisions.length > 0) {
    await graph.query(
      `UNWIND $decisions AS decision
       CREATE (d:Decision {sha: decision.sha, message: decision.message, authorName: decision.authorName})
       WITH d
       MATCH (project:Project {id: $workspaceId})
       CREATE (d)-[:IN]->(project)`,
      {
        params: {
          decisions: decisions.map(({ sha, message, authorName }) => ({
            sha,
            message,
            authorName,
          })),
          workspaceId,
        },
      },
    );
    const changes = decisions.flatMap((decision) =>
      decision.files.map((path) => ({ sha: decision.sha, path })),
    );
    if (changes.length > 0) {
      await graph.query(
        `UNWIND $changes AS change
         MATCH (decision:Decision {sha: change.sha}), (document:Document {path: change.path})
         CREATE (decision)-[:CHANGES]->(document)`,
        { params: { changes } },
      );
    }
    await graph.query(
      `UNWIND $decisions AS decision
       MATCH (d:Decision {sha: decision.sha}), (person:Person)
       WHERE toLower(decision.authorName) CONTAINS toLower(person.username)
          OR toLower(person.username) CONTAINS toLower(decision.authorName)
       CREATE (decision)-[:DECIDED_BY]->(person)`,
      {
        params: {
          decisions: decisions.map(({ sha, authorName }) => ({ sha, authorName })),
        },
      },
    );
  }

  if (messages.length > 0) {
    await graph.query(
      `UNWIND $messages AS message
       CREATE (m:Message {id: message.id, content: message.content, username: message.username, channel: message.channel, createdAt: message.createdAt})
       WITH m, message
       MATCH (project:Project {id: $workspaceId})
       CREATE (m)-[:ABOUT]->(project)
       WITH m, message
       MATCH (person:Person {id: message.userId})
       CREATE (m)-[:SAID_BY]->(person)`,
      {
        params: {
          workspaceId,
          messages: messages.map((message) => ({
            id: message.id,
            content: clip(message.content, 300),
            username: message.user.username,
            channel: 'chat',
            createdAt: message.createdAt.getTime(),
            userId: message.user.id,
          })),
        },
      },
    );
  }

  await restoreAnswers(graph, rememberedAnswers);
}

function scheduleSync(workspaceId: string): Promise<void> {
  const current = syncs.get(workspaceId);
  if (current) {
    return current;
  }

  const pending = syncWorkspace(workspaceId).finally(() => {
    syncs.delete(workspaceId);
  });
  syncs.set(workspaceId, pending);
  return pending;
}

type Seed = { label: string; key: string };
type LinkedSource = BrainSource & { linkLabel: string; linkKey: string };
type SavedLink = { label: string; key: string };
type SavedAnswer = {
  id: string;
  question: string;
  text: string;
  createdAt: number;
  links: SavedLink[];
};

function labelName(value: string | undefined): string {
  const match = value?.match(/[A-Za-z]+/);
  return match?.[0] ?? '';
}

function sourceKey(source: BrainSource): string {
  return `${source.kind}:${source.title}:${source.excerpt}`;
}

async function readSavedAnswers(graph: Graph): Promise<SavedAnswer[]> {
  try {
    const result = await graph.roQuery(
      `MATCH (answer:Answer)
       OPTIONAL MATCH (answer)-[:BASED_ON]->(node)
       RETURN answer.id AS id, answer.question AS question, answer.text AS text,
              answer.createdAt AS createdAt, labels(node) AS label,
              coalesce(node.path, node.sha, node.id, '') AS key`,
    );
    const grouped = new Map<string, SavedAnswer>();
    for (const row of rowsFrom(result)) {
      const id = row.id ?? '';
      if (!id) continue;
      const current = grouped.get(id) ?? {
        id,
        question: row.question ?? '',
        text: row.text ?? '',
        createdAt: Number(row.createdAt ?? 0),
        links: [],
      };
      const label = labelName(row.label);
      const key = row.key ?? '';
      if (label && key) {
        current.links.push({ label, key });
      }
      grouped.set(id, current);
    }
    return [...grouped.values()];
  } catch (error) {
    if (isUnavailable(error)) {
      asGraphError(error);
    }
    return [];
  }
}

async function restoreAnswers(graph: Graph, answers: SavedAnswer[]): Promise<void> {
  for (const answer of answers) {
    await graph.query(
      `CREATE (:Answer {id: $id, question: $question, text: $text, createdAt: $createdAt})`,
      {
        params: {
          id: answer.id,
          question: answer.question,
          text: answer.text,
          createdAt: answer.createdAt,
        },
      },
    );
    for (const link of answer.links) {
      const match =
        link.label === 'Document'
          ? 'MATCH (answer:Answer {id: $id}), (node:Document {path: $key})'
          : link.label === 'Person'
            ? 'MATCH (answer:Answer {id: $id}), (node:Person {id: $key})'
            : link.label === 'Decision'
              ? 'MATCH (answer:Answer {id: $id}), (node:Decision {sha: $key})'
              : link.label === 'Message'
                ? 'MATCH (answer:Answer {id: $id}), (node:Message {id: $key})'
                : '';
      if (!match) continue;
      await graph.query(`${match} CREATE (answer)-[:BASED_ON]->(node)`, {
        params: { id: answer.id, key: link.key },
      });
    }
  }
}

async function findSeeds(workspaceId: string, terms: string[]): Promise<Seed[]> {
  if (terms.length === 0) return [];
  const queries: Array<{ cypher: string; label: string }> = [
    {
      label: 'Person',
      cypher: `UNWIND $terms AS term
               MATCH (person:Person)
               WHERE toLower(person.username) CONTAINS term
               RETURN person.id AS key LIMIT 8`,
    },
    {
      label: 'Document',
      cypher: `UNWIND $terms AS term
               MATCH (document:Document)
               WHERE toLower(document.path) CONTAINS term
                  OR toLower(document.name) CONTAINS term
                  OR toLower(document.excerpt) CONTAINS term
               RETURN document.path AS key LIMIT 8`,
    },
    {
      label: 'Decision',
      cypher: `UNWIND $terms AS term
               MATCH (decision:Decision)
               WHERE toLower(decision.message) CONTAINS term
                  OR toLower(decision.authorName) CONTAINS term
               RETURN decision.sha AS key LIMIT 8`,
    },
    {
      label: 'Message',
      cypher: `UNWIND $terms AS term
               MATCH (message:Message)
               WHERE toLower(message.content) CONTAINS term
                  OR toLower(message.username) CONTAINS term
                  OR toLower(message.channel) CONTAINS term
               RETURN message.id AS key LIMIT 8`,
    },
    {
      label: 'Answer',
      cypher: `UNWIND $terms AS term
               MATCH (answer:Answer)
               WHERE toLower(answer.question) CONTAINS term
                  OR toLower(answer.text) CONTAINS term
               RETURN answer.id AS key LIMIT 4`,
    },
  ];
  const seeds: Seed[] = [];
  for (const query of queries) {
    const found = rowsFrom(await queryGraph(workspaceId, query.cypher, { terms }));
    for (const row of found) {
      if (!row.key) continue;
      if (seeds.some((seed) => seed.label === query.label && seed.key === row.key)) continue;
      seeds.push({ label: query.label, key: row.key });
    }
  }
  return seeds.slice(0, 8);
}

async function edgeTypesForSeeds(workspaceId: string, seeds: Seed[]): Promise<Set<string>> {
  const edges = new Set<string>();
  const groups = new Map<string, string[]>();
  for (const seed of seeds) {
    const keys = groups.get(seed.label) ?? [];
    keys.push(seed.key);
    groups.set(seed.label, keys);
  }
  const property: Record<string, string> = {
    Person: 'id',
    Document: 'path',
    Decision: 'sha',
    Message: 'id',
    Answer: 'id',
    Project: 'id',
  };
  for (const [label, keys] of groups) {
    const field = property[label];
    if (!field) continue;
    const rows = rowsFrom(
      await queryGraph(
        workspaceId,
        `UNWIND $keys AS key
         MATCH (node:${label} {${field}: key})-[rel]-()
         RETURN DISTINCT type(rel) AS relType`,
        { keys },
      ),
    );
    for (const row of rows) {
      const relType = labelName(row.relType);
      if (relType) edges.add(relType);
    }
  }
  return edges;
}

async function edgeTypesMatchingTerms(workspaceId: string, terms: string[]): Promise<Set<string>> {
  if (terms.length === 0) return new Set();
  const rows = rowsFrom(
    await queryGraph(
      workspaceId,
      `UNWIND $terms AS term
       MATCH ()-[rel]->()
       WHERE toLower(type(rel)) CONTAINS term
       RETURN DISTINCT type(rel) AS relType
       LIMIT 8`,
      { terms },
    ),
  );
  return new Set(rows.map((row) => labelName(row.relType)).filter(Boolean));
}

async function latestAnswer(workspaceId: string): Promise<Seed | null> {
  const rows = rowsFrom(
    await queryGraph(
      workspaceId,
      `MATCH (answer:Answer)
       RETURN answer.id AS key
       ORDER BY answer.createdAt DESC
       LIMIT 1`,
      {},
    ),
  );
  const key = rows[0]?.key;
  return key ? { label: 'Answer', key } : null;
}

function hasEdge(edges: Set<string>, names: string[]): boolean {
  return names.some((name) => edges.has(name));
}

async function peopleAgent(
  workspaceId: string,
  seeds: Seed[],
  edges: Set<string>,
): Promise<LinkedSource[]> {
  if (!hasEdge(edges, ['OWNS', 'MEMBER_OF'])) return [];
  const personIds = seeds.filter((seed) => seed.label === 'Person').map((seed) => seed.key);
  const rows = rowsFrom(
    await queryGraph(
      workspaceId,
      personIds.length > 0
        ? `UNWIND $personIds AS personId
           MATCH (person:Person {id: personId})-[membership:MEMBER_OF]->(:Project {id: $workspaceId})
           RETURN person.id AS linkKey, person.username AS username, membership.role AS role`
        : edges.has('OWNS')
          ? `MATCH (person:Person)-[:OWNS]->(:Project {id: $workspaceId})
             RETURN person.id AS linkKey, person.username AS username, 'OWNER' AS role`
          : `MATCH (person:Person)-[membership:MEMBER_OF]->(:Project {id: $workspaceId})
             RETURN person.id AS linkKey, person.username AS username, membership.role AS role
             LIMIT 4`,
      { workspaceId, personIds },
    ),
  );
  return rows.slice(0, 4).map((person) => {
    const role = person.role === 'OWNER' ? 'owner' : 'collaborator';
    const username = person.username ?? 'Unknown';
    return {
      kind: 'member' as const,
      title: username,
      excerpt: `${username} is the ${role} of this workspace.`,
      linkLabel: 'Person',
      linkKey: person.linkKey ?? username,
    };
  });
}

async function decisionAgent(
  workspaceId: string,
  seeds: Seed[],
  edges: Set<string>,
): Promise<LinkedSource[]> {
  if (!hasEdge(edges, ['CHANGES', 'DECIDED_BY'])) return [];
  const shas = seeds.filter((seed) => seed.label === 'Decision').map((seed) => seed.key);
  const paths = seeds.filter((seed) => seed.label === 'Document').map((seed) => seed.key);
  if (shas.length === 0 && paths.length === 0) return [];
  const rows = rowsFrom(
    await queryGraph(
      workspaceId,
      `MATCH (decision:Decision)-[:CHANGES]->(document:Document)
       WHERE decision.sha IN $shas OR document.path IN $paths
       RETURN decision.sha AS linkKey, decision.message AS message, decision.authorName AS author, document.path AS path
       LIMIT 3`,
      { shas, paths },
    ),
  );
  return rows.map((decision) => ({
    kind: 'decision' as const,
    title: decision.path || 'Commit',
    ...(decision.path ? { path: decision.path } : {}),
    excerpt: `${decision.author ?? 'Someone'} — ${decision.message ?? ''}`,
    linkLabel: 'Decision',
    linkKey: decision.linkKey ?? '',
  }));
}

async function chatAgent(
  workspaceId: string,
  seeds: Seed[],
  edges: Set<string>,
): Promise<LinkedSource[]> {
  if (!edges.has('SAID_BY')) return [];
  const messageIds = seeds.filter((seed) => seed.label === 'Message').map((seed) => seed.key);
  const personIds = seeds.filter((seed) => seed.label === 'Person').map((seed) => seed.key);
  if (messageIds.length === 0 && personIds.length === 0) return [];
  const rows = rowsFrom(
    await queryGraph(
      workspaceId,
      messageIds.length > 0
        ? `UNWIND $messageIds AS messageId
           MATCH (message:Message {id: messageId})-[:SAID_BY]->(person:Person)
           RETURN message.id AS linkKey, person.username AS username, message.content AS content
           LIMIT 3`
        : `UNWIND $personIds AS personId
           MATCH (message:Message)-[:SAID_BY]->(person:Person {id: personId})
           RETURN message.id AS linkKey, person.username AS username, message.content AS content
           ORDER BY message.createdAt DESC
           LIMIT 3`,
      { messageIds, personIds },
    ),
  );
  return rows.map((message) => ({
    kind: 'chat' as const,
    title: `Chat · ${message.username ?? 'someone'}`,
    excerpt: message.content ?? '',
    linkLabel: 'Message',
    linkKey: message.linkKey ?? '',
  }));
}

async function fileAgent(
  workspaceId: string,
  seeds: Seed[],
  edges: Set<string>,
): Promise<LinkedSource[]> {
  if (!edges.has('PART_OF')) return [];
  const paths = seeds.filter((seed) => seed.label === 'Document').map((seed) => seed.key);
  if (paths.length === 0) return [];
  const rows = rowsFrom(
    await queryGraph(
      workspaceId,
      `UNWIND $paths AS path
       MATCH (document:Document {path: path})-[:PART_OF]->(:Project {id: $workspaceId})
       RETURN document.path AS path, document.excerpt AS excerpt`,
      { workspaceId, paths },
    ),
  );
  return rows.map((document) => ({
    kind: 'file' as const,
    title: document.path ?? 'File',
    ...(document.path ? { path: document.path } : {}),
    excerpt: document.excerpt || 'File in this workspace.',
    linkLabel: 'Document',
    linkKey: document.path ?? '',
  }));
}

async function sourcesFromAnswer(workspaceId: string, answerId: string): Promise<LinkedSource[]> {
  const rows = rowsFrom(
    await queryGraph(
      workspaceId,
      `MATCH (answer:Answer {id: $answerId})-[:BASED_ON]->(node)
       OPTIONAL MATCH (node)-[membership:MEMBER_OF]->(:Project)
       OPTIONAL MATCH (node)-[:CHANGES]->(document:Document)
       RETURN labels(node) AS label,
              coalesce(node.id, node.path, node.sha, '') AS linkKey,
              coalesce(document.path, node.path, '') AS path,
              coalesce(node.username, node.authorName, '') AS actor,
              coalesce(node.message, node.content, node.excerpt, '') AS excerpt,
              membership.role AS role`,
      { answerId },
    ),
  );
  return rows.flatMap((row): LinkedSource[] => {
    const label = labelName(row.label);
    const linkKey = row.linkKey ?? '';
    if (!label || !linkKey) return [];
    if (label === 'Person') {
      const role = row.role === 'OWNER' ? 'owner' : 'collaborator';
      const username = row.actor || 'Unknown';
      return [
        {
          kind: 'member' as const,
          title: username,
          excerpt: `${username} is the ${role} of this workspace.`,
          linkLabel: 'Person',
          linkKey,
        },
      ];
    }
    if (label === 'Decision') {
      return [
        {
          kind: 'decision' as const,
          title: row.path || 'Commit',
          ...(row.path ? { path: row.path } : {}),
          excerpt: `${row.actor || 'Someone'} — ${row.excerpt ?? ''}`,
          linkLabel: 'Decision',
          linkKey,
        },
      ];
    }
    if (label === 'Message') {
      return [
        {
          kind: 'chat' as const,
          title: `Chat · ${row.actor || 'someone'}`,
          excerpt: row.excerpt ?? '',
          linkLabel: 'Message',
          linkKey,
        },
      ];
    }
    return [
      {
        kind: 'file' as const,
        title: row.path || 'File',
        ...(row.path ? { path: row.path } : {}),
        excerpt: row.excerpt || 'File linked to the previous answer.',
        linkLabel: 'Document',
        linkKey,
      },
    ];
  });
}

function answerText(sources: BrainSource[]): string {
  if (sources.length === 0) {
    return 'The FalkorDB graph has no linked source for that question.';
  }
  return sources.map((source) => `${source.title}: ${source.excerpt}`).join('\n\n');
}

async function writeAnswer(
  workspaceId: string,
  question: string,
  sources: LinkedSource[],
): Promise<BrainAnswer['sources']> {
  const answerId = `ans_${Date.now()}`;
  await queryGraph(
    workspaceId,
    `CREATE (:Answer {id: $answerId, question: $question, text: '', createdAt: $createdAt})`,
    { answerId, question, createdAt: Date.now() },
  );
  const matchByLabel: Record<string, string> = {
    Document: 'MATCH (answer:Answer {id: $answerId}), (node:Document {path: $key})',
    Person: 'MATCH (answer:Answer {id: $answerId}), (node:Person {id: $key})',
    Decision: 'MATCH (answer:Answer {id: $answerId}), (node:Decision {sha: $key})',
    Message: 'MATCH (answer:Answer {id: $answerId}), (node:Message {id: $key})',
  };
  for (const source of sources) {
    const match = matchByLabel[source.linkLabel];
    if (!match || !source.linkKey) continue;
    await queryGraph(workspaceId, `${match} CREATE (answer)-[:BASED_ON]->(node)`, {
      answerId,
      key: source.linkKey,
    });
  }
  const linked = (await sourcesFromAnswer(workspaceId, answerId)).slice(0, 5);
  const text = answerText(linked);
  await queryGraph(workspaceId, `MATCH (answer:Answer {id: $answerId}) SET answer.text = $text`, {
    answerId,
    text,
  });
  return linked.map((source) => ({
    kind: source.kind,
    title: source.title,
    excerpt: source.excerpt,
    ...(source.path ? { path: source.path } : {}),
  }));
}

export class GraphService {
  async ask(workspaceId: string, question: string): Promise<BrainAnswer> {
    try {
      await scheduleSync(workspaceId);
    } catch (error) {
      asGraphError(error);
    }

    const terms = termsFromQuestion(question);
    const trace = ['Context agent'];
    let seeds = await findSeeds(workspaceId, terms);
    let edges = new Set<string>([
      ...(await edgeTypesForSeeds(workspaceId, seeds)),
      ...(await edgeTypesMatchingTerms(workspaceId, terms)),
    ]);

    const entitySeeds = seeds.filter((seed) => seed.label !== 'Answer');
    if (
      entitySeeds.length === 0 &&
      !hasEdge(edges, ['OWNS', 'MEMBER_OF', 'CHANGES', 'DECIDED_BY', 'SAID_BY', 'PART_OF'])
    ) {
      const previous = await latestAnswer(workspaceId);
      if (previous) {
        trace.push('Context agent opened the previous Answer');
        const recalled = (await sourcesFromAnswer(workspaceId, previous.key)).slice(0, 5);
        const sources = await writeAnswer(workspaceId, question, recalled);
        trace.push('Action agent read BASED_ON and wrote Answer');
        return { answer: answerText(sources), sources, trace };
      }
    }

    if (seeds.length === 0 && edges.size === 0) {
      seeds = [{ label: 'Project', key: workspaceId }];
      edges = await edgeTypesForSeeds(workspaceId, seeds);
    }

    const seedLabels = [...new Set(seeds.map((seed) => seed.label))];
    trace.push(
      `Context agent found ${seedLabels.join(', ') || 'no nodes'}; edges ${[...edges].join(', ') || 'none'}`,
    );

    const found: LinkedSource[] = [];
    if (hasEdge(edges, ['OWNS', 'MEMBER_OF'])) {
      trace.push('People agent, because OWNS or MEMBER_OF');
      found.push(...(await peopleAgent(workspaceId, seeds, edges)));
    }
    if (hasEdge(edges, ['CHANGES', 'DECIDED_BY'])) {
      trace.push('Decision agent, because CHANGES or DECIDED_BY');
      found.push(...(await decisionAgent(workspaceId, seeds, edges)));
    }
    if (edges.has('SAID_BY')) {
      trace.push('Chat agent, because SAID_BY');
      found.push(...(await chatAgent(workspaceId, seeds, edges)));
    }
    if (edges.has('PART_OF')) {
      trace.push('File agent, because PART_OF');
      found.push(...(await fileAgent(workspaceId, seeds, edges)));
    }

    const unique = found
      .filter(
        (source, index) =>
          found.findIndex((candidate) => sourceKey(candidate) === sourceKey(source)) === index,
      )
      .slice(0, 5);
    const sources = await writeAnswer(workspaceId, question, unique);
    trace.push('Action agent wrote Answer');
    return { answer: answerText(sources), sources, trace };
  }
}

export const graphService = new GraphService();
