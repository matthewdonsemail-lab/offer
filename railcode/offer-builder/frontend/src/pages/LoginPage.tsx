import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogIn, AlertCircle } from 'lucide-react';
import { api } from '@/lib/api';
import { TropicalTideBackground } from '@/components/background-gradient/tropical-tide-background';

/**
 * Railcode edition: there is no password form. The worker trusts the
 * verified Railcode org caller (ctx.user), so signing in means proving a
 * Railcode session — opening the app URL signs you in via your org.
 */
export function LoginPage({ onLogin }: { onLogin?: (user: any) => void } = {}) {
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await api.auth.me();
        if (!cancelled && me?.user) {
          console.log('[LoginPage] Railcode session active', me.user?.email);
          onLogin?.(me.user);
          navigate('/offers');
        }
      } catch (err: any) {
        console.warn('[LoginPage] no Railcode session yet');
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <TropicalTideBackground className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md py-16">
        <div className="bg-white/80 backdrop-blur-sm rounded-xl shadow-lg p-8 space-y-5 text-center">
          <h2 className="text-xl font-semibold text-gray-800">Offer</h2>
          {error && (
            <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg text-sm">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}
          {checking ? (
            <p className="text-sm text-gray-500">Checking your Railcode session…</p>
          ) : (
            <>
              <p className="text-sm text-gray-500">
                Sign in with your Railcode organization account to continue.
                Members are managed in Railcode — no separate password.
              </p>
              <button
                onClick={() => {
                  setError('');
                  window.location.assign('/');
                }}
                className="w-full flex items-center justify-center gap-2 bg-brand-600 hover:bg-brand-700 text-white font-semibold py-3 rounded-lg transition"
              >
                <LogIn className="w-5 h-5" />
                Sign in with Railcode
              </button>
            </>
          )}
        </div>
      </div>
    </TropicalTideBackground>
  );
}
