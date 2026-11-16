import { useState } from 'react';
import { api } from '../lib/api.js';
import { ErrorBanner } from './ui.js';

export interface ProviderInfo {
  name: string;
  configured: boolean;
  authorize_path: string;
}

interface LoginScreenProps {
  providers: ProviderInfo[];
  mockEnabled: boolean;
  error: string | null;
  onError: (message: string) => void;
  onSignedIn: () => void;
}

const MARKS: Record<string, string> = {
  google:
    'M12 11v3.6h5.9c-.26 1.5-1.86 4.4-5.9 4.4-3.55 0-6.45-2.94-6.45-6.6S8.45 5.8 12 5.8c2.03 0 3.4.87 4.18 1.6l2.85-2.74C17.24 3.15 14.86 2 12 2 6.9 2 2.8 6.1 2.8 11.2S6.9 20.4 12 20.4c6.05 0 9.4-4.24 9.4-10.22 0-.92-.1-1.62-.22-2.32H12Z',
  github:
    'M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48l-.01-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.15-1.11-1.46-1.11-1.46-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.36 1.09 2.94.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85l-.01 2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z',
};

const LABELS: Record<string, string> = {
  google: 'Continue with Google',
  github: 'Continue with GitHub',
};

export function LoginScreen(props: LoginScreenProps): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [demoUser, setDemoUser] = useState('ada');

  const start = (provider: string): void => {
    setBusy(provider);
    api.beginLogin(provider);
  };

  const signInDemo = async (provider: string): Promise<void> => {
    setBusy(`${provider}:demo`);
    try {
      await api.mockLogin(provider, demoUser);
      props.onSignedIn();
    } catch (error) {
      props.onError(error instanceof Error ? error.message : 'Sign-in failed');
      setBusy(null);
    }
  };

  return (
    <main className="login">
      <div className="login__card">
        <p className="brand-mark" aria-hidden="true">
          💸
        </p>
        <h1 className="login__title">Expense Tracker</h1>
        <p className="login__lede">
          Track spending by category, watch a monthly budget, and get real-time alerts when a
          threshold is crossed. Sign in with an existing account — no passwords here.
        </p>

        {props.error ? <ErrorBanner message={props.error} /> : null}

        <div className="login__actions">
          {props.providers.map((provider) => (
            <button
              key={provider.name}
              type="button"
              className="sso-btn"
              onClick={() => start(provider.name)}
              disabled={busy !== null || !provider.configured}
              title={provider.configured ? undefined : `${provider.name} is not configured on this server`}
            >
              <svg className="sso-btn__mark" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                <path d={MARKS[provider.name] ?? ''} />
              </svg>
              {LABELS[provider.name] ?? `Continue with ${provider.name}`}
            </button>
          ))}
        </div>

        {!props.providers.every((provider) => provider.configured) ? (
          <p className="field__hint">
            A provider is greyed out until its OAuth credentials are set in <code>backend/.env</code>. See{' '}
            <code>README.md</code> for the Google and GitHub setup.
          </p>
        ) : null}

        {props.mockEnabled ? (
          <>
            <p className="divider">or evaluate locally without credentials</p>
            <div className="field">
              <label className="field__label" htmlFor="demo-user">
                Stub identity
              </label>
              <input
                id="demo-user"
                className="input"
                value={demoUser}
                onChange={(event) => setDemoUser(event.target.value)}
                aria-describedby="demo-user-hint"
              />
              <span className="field__hint" id="demo-user-hint">
                Creates a local account through the same code path as a real SSO callback. Disabled unless{' '}
                <code>ALLOW_MOCK_AUTH=1</code>.
              </span>
            </div>
            <div className="row row--tight">
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => void signInDemo('google')} disabled={busy !== null}>
                Stub as Google
              </button>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => void signInDemo('github')} disabled={busy !== null}>
                Stub as GitHub
              </button>
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}
