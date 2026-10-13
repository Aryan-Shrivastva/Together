import type { ReactNode } from 'react';

import { useAuth } from './AuthContext';

type ProtectedRouteProps = {
  children: ReactNode;
  fallback: ReactNode;
};

export function ProtectedRoute({ children, fallback }: ProtectedRouteProps) {
  const { isLoading, user } = useAuth();

  if (isLoading) {
    return (
      <p className="px-6 py-16 text-sm uppercase tracking-[0.22em] text-slate-400">
        Checking your session
      </p>
    );
  }

  return user ? children : fallback;
}
