import { graphService } from './graphService.js';

export type BrainSource = {
  kind: 'file' | 'chat' | 'member' | 'decision';
  title: string;
  excerpt: string;
  path?: string;
};

export type BrainAnswer = {
  answer: string;
  sources: BrainSource[];
  trace: string[];
};

export class BrainService {
  ask(workspaceId: string, question: string): Promise<BrainAnswer> {
    return graphService.ask(workspaceId, question);
  }
}

export const brainService = new BrainService();
