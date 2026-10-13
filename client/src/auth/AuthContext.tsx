import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type AuthUser = {
  id: string;
  githubId: string;
  username: string;
  avatarUrl: string;
  email: string | null;
  createdAt: string;
};

type AuthContextValue = {
  user: AuthUser | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  signIn: () => void;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function getErrorMessage(payload: unknown): string {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'error' in payload &&
    typeof payload.error === 'string'
  ) {
    return payload.error;
  }

  return 'Unable to check your session.';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/me', { credentials: 'include' });

      if (response.status === 401) {
        setUser(null);
        return;
      }

      const payload: unknown = await response.json();

      if (!response.ok) {
        setUser(null);
        setError(getErrorMessage(payload));
        return;
      }

      if (
        typeof payload === 'object' &&
        payload !== null &&
        'user' in payload &&
        typeof payload.user === 'object' &&
        payload.user !== null
      ) {
        setUser(payload.user as AuthUser);
        return;
      }

      setUser(null);
      setError('The session response was invalid.');
    } catch {
      setUser(null);
      setError('Unable to reach the authentication service.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      error,
      refresh,
      signIn: () => {
        const params = new URLSearchParams(window.location.search);
        params.delete('auth');
        const search = params.toString();
        const returnTo = `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`;
        window.location.assign(`/auth/github?returnTo=${encodeURIComponent(returnTo)}`);
      },
      signOut: async () => {
        const response = await fetch('/auth/logout', {
          method: 'POST',
          credentials: 'include',
        });

        if (!response.ok) {
          throw new Error('Unable to sign out.');
        }

        await refresh();
      },
    }),
    [error, isLoading, refresh, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider.');
  }

  return context;
}
