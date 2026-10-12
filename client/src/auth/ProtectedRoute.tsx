import type { ReactNode } from 'react';

import { useAuth } from './AuthContext';

type ProtectedRouteProps = {
  children: ReactNode;
  fallback: ReactNode;
};

export function ProtectedRoute({ children, fallback }: ProtectedRouteProps) {
  const { isLoading, user } = useAuth();

  if (isLoading) {
    return <p className="text-slate-300">Checking your session…</p>;
  }

  return user ? children : fallback;
}
