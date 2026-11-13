import { type LoginInput, loginSchema } from '@bedex/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { DeliveryPattern } from '../components/DeliveryPattern';
import { FullPageSpinner } from '../components/RequireRole';
import { ApiError, homePathFor, login } from '../lib/api';
import { useAuth } from '../stores/auth';

export function LoginPage() {
  const { status, user } = useAuth();
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);
  const from = (useLocation().state as { from?: string } | null)?.from;
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  if (status === 'unknown') return <FullPageSpinner />;
  if (status === 'authenticated' && user) return <Navigate to={homePathFor(user.role)} replace />;

  const onSubmit = handleSubmit(async (values) => {
    try {
      const session = await login(values);
      const home = homePathFor(session.user.role);
      navigate(from?.startsWith(home) ? from : home, { replace: true });
    } catch (err) {
      setError('root', { message: err instanceof ApiError ? err.message : 'Could not reach the server. Try again.' });
    }
  });

  return (
    <div className="relative isolate flex min-h-screen items-center justify-center overflow-hidden px-4">
      <DeliveryPattern />
      <div className="relative w-full max-w-sm">
        <div className="mb-8 text-center">
          <img src="/BedExLogo.png" alt="BedEx Delivery" width={412} height={137} className="mx-auto h-16 w-auto" />
          <p className="mt-4 text-slate-600">Sign in to the delivery portal</p>
        </div>
        <form onSubmit={onSubmit} className="card space-y-4 p-6 shadow-xl shadow-slate-900/5" noValidate>
          <div>
            <label htmlFor="identifier" className="label">
              Email or phone
            </label>
            <input id="identifier" autoComplete="username" className="input min-h-tap" {...register('identifier')} />
            {errors.identifier && <p className="mt-1 text-sm text-danger">{errors.identifier.message}</p>}
          </div>
          <div>
            <label htmlFor="password" className="label">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                className="input min-h-tap pr-12"
                {...register('password')}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                className="absolute inset-y-0 right-0 flex min-w-tap items-center justify-center rounded-r-md text-slate-500 hover:text-ink"
              >
                {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
              </button>
            </div>
            {errors.password && <p className="mt-1 text-sm text-danger">{errors.password.message}</p>}
          </div>
          {errors.root && (
            <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
              {errors.root.message}
            </p>
          )}
          <button type="submit" className="btn-primary min-h-tap w-full" disabled={isSubmitting}>
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
