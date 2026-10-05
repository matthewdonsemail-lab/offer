import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { finishSignIn } from '@/lib/oauth';
import { TropicalTideBackground } from '@/components/background-gradient/tropical-tide-background';

export function CallbackPage({ onLogin }: { onLogin?: () => void }) {
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    finishSignIn(window.location.search)
      .then(() => {
        onLogin?.();
        navigate('/offers', { replace: true });
      })
      .catch((err: Error) => setError(err.message || 'Sign-in failed'));
  }, [navigate, onLogin]);

  return (
    <TropicalTideBackground className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white/80 backdrop-blur-sm rounded-xl shadow-lg p-8 text-center space-y-4">
        {error ? (
          <>
            <div className="flex items-center gap-2 text-red-600 bg-red-50 p-3 rounded-lg text-sm text-left">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
            <Link to="/login" className="text-brand-600 hover:underline text-sm">
              Back to sign in
            </Link>
          </>
        ) : (
          <p className="text-gray-700">Signing you in with Twenty...</p>
        )}
      </div>
    </TropicalTideBackground>
  );
}
