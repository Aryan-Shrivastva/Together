import { useState } from 'react';

type BrainSource = {
  kind: 'file' | 'chat' | 'member' | 'decision';
  title: string;
  excerpt: string;
  path?: string;
};

type BrainAnswer = {
  answer: string;
  sources: BrainSource[];
  trace: string[];
};

function isBrainAnswer(value: unknown): value is BrainAnswer {
  return (
    typeof value === 'object' &&
    value !== null &&
    'answer' in value &&
    typeof value.answer === 'string' &&
    'sources' in value &&
    Array.isArray(value.sources) &&
    'trace' in value &&
    Array.isArray(value.trace)
  );
}

function getErrorMessage(payload: unknown): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof payload.error === 'string'
  ) {
    return payload.error;
  }

  return 'The workspace brain could not answer that.';
}

const prompts = [
  'Who owns this workspace?',
  'Where is the README?',
  'What did the team say in chat?',
  'What did we just find?',
];

export function WorkspaceBrain({
  workspaceId,
  onOpenFile,
  onClose,
}: {
  workspaceId: string;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<BrainAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAsking, setIsAsking] = useState(false);

  async function ask(nextQuestion = question) {
    const trimmed = nextQuestion.trim();
    if (trimmed.length < 2) {
      setError('Ask something a little more specific.');
      return;
    }

    setQuestion(trimmed);
    setIsAsking(true);
    setError(null);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/brain`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: trimmed }),
      });
      const payload: unknown = await response.json();

      if (!response.ok || !isBrainAnswer(payload)) {
        throw new Error(getErrorMessage(payload));
      }

      setAnswer(payload);
    } catch (askError) {
      setAnswer(null);
      setError(
        askError instanceof Error ? askError.message : 'The workspace brain could not answer that.',
      );
    } finally {
      setIsAsking(false);
    }
  }

  return (
    <aside className="absolute bottom-6 right-0 top-0 z-10 flex w-96 max-w-full flex-col border-l border-[#7a6856] bg-[#4e4338] shadow-2xl">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[#7a6856] px-4 text-xs font-semibold uppercase tracking-wide">
        <span>Workspace brain</span>
        <button
          className="text-lg text-[#f5b942] hover:text-white"
          type="button"
          aria-label="Close workspace brain"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="border-b border-[#7a6856] px-4 py-3 text-xs leading-5 text-[#f5b942]">
        Searches through agents chosen by the FalkorDB graph. The trace shows which link let each
        agent run.
      </div>
      <form
        className="flex shrink-0 gap-2 border-b border-[#7a6856] p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <input
          className="min-w-0 flex-1 rounded border border-[#9a846e] bg-[#3a3128] px-2 py-2 text-xs text-[#fff4df] outline-none focus:border-cyan-300"
          value={question}
          placeholder="Ask about a file, a person, or the chat"
          onChange={(event) => setQuestion(event.target.value)}
        />
        <button
          className="rounded bg-cyan-300 px-3 py-2 text-xs font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
          type="submit"
          disabled={isAsking}
        >
          {isAsking ? 'Looking…' : 'Ask'}
        </button>
      </form>
      <div className="flex shrink-0 flex-wrap gap-2 px-3 py-2">
        {prompts.map((prompt) => (
          <button
            key={prompt}
            className="rounded-full border border-[#9a846e] px-2 py-1 text-[11px] text-[#fff4df] hover:border-cyan-300"
            type="button"
            onClick={() => void ask(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-3 text-xs leading-5">
        {error ? (
          <p className="rounded border border-rose-400/40 bg-rose-500/10 p-2 text-rose-200">
            {error}
          </p>
        ) : null}
        {answer ? (
          <>
            <p className="whitespace-pre-wrap text-[#fff4df]">{answer.answer}</p>
            {answer.trace.length > 0 ? (
              <ol className="space-y-1 rounded border border-[#7a6856] bg-[#3a3128] p-2 text-[11px] text-[#ffd56a]">
                {answer.trace.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            ) : null}
            {answer.sources.length > 0 ? (
              <ul className="space-y-2">
                {answer.sources.map((source) => (
                  <li
                    key={`${source.kind}-${source.title}`}
                    className="rounded border border-[#7a6856] bg-[#3a3128] p-2"
                  >
                    <p className="text-[11px] uppercase tracking-[0.16em] text-cyan-300">
                      {source.kind}
                    </p>
                    {source.path ? (
                      <button
                        className="mt-1 text-left font-semibold text-[#ffd56a] hover:underline"
                        type="button"
                        onClick={() => onOpenFile(source.path ?? '')}
                      >
                        {source.title}
                      </button>
                    ) : (
                      <p className="mt-1 font-semibold text-[#fff4df]">{source.title}</p>
                    )}
                    <p className="mt-1 text-[#e2c7a4]">{source.excerpt}</p>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="text-[#e2c7a4]">
            Try “Who owns this workspace?” or the name of a file you expect to be in the repo.
          </p>
        )}
      </div>
    </aside>
  );
}
