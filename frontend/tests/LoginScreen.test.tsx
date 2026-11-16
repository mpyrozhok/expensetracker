// @vitest-environment jsdom
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LoginScreen } from '../src/components/LoginScreen.js';
import { api } from '../src/lib/api.js';
import { installFetch, jsonResponse } from './support.js';

const bothConfigured = [
  { name: 'google', configured: true, authorize_path: '/api/auth/google/login' },
  { name: 'github', configured: true, authorize_path: '/api/auth/github/login' },
];

function renderScreen(overrides: Partial<React.ComponentProps<typeof LoginScreen>> = {}) {
  const props = {
    providers: bothConfigured,
    mockEnabled: false,
    error: null,
    onError: vi.fn(),
    onSignedIn: vi.fn(),
    ...overrides,
  };
  render(<LoginScreen {...props} />);
  return props;
}

describe('LoginScreen', () => {
  it('offers both SSO providers and no password field', () => {
    renderScreen();
    expect(screen.getByRole('button', { name: /continue with google/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /continue with github/i })).toBeEnabled();
    // SSO only: there is deliberately no way to type credentials here.
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /email/i })).not.toBeInTheDocument();
  });

  it('hands off to the provider endpoint as a full-page navigation', async () => {
    const beginLogin = vi.spyOn(api, 'beginLogin').mockImplementation(() => undefined);
    renderScreen();

    await userEvent.click(screen.getByRole('button', { name: /continue with github/i }));

    expect(beginLogin).toHaveBeenCalledWith('github');
  });

  it('explains and disables a provider whose OAuth credentials are missing', async () => {
    renderScreen({
      providers: [
        { name: 'google', configured: true, authorize_path: '/api/auth/google/login' },
        { name: 'github', configured: false, authorize_path: '/api/auth/github/login' },
      ],
    });

    const github = screen.getByRole('button', { name: /continue with github/i });
    expect(github).toBeDisabled();
    expect(github).toHaveAttribute('title', 'github is not configured on this server');
    expect(screen.getByText(/greyed out until its OAuth credentials/i)).toBeInTheDocument();
  });

  it('keeps the stub sign-in hidden unless the backend allows mock auth', () => {
    renderScreen({ mockEnabled: false });
    expect(screen.queryByLabelText(/stub identity/i)).not.toBeInTheDocument();
  });

  it('offers the stub sign-in when the backend allows mock auth', () => {
    renderScreen({ mockEnabled: true });
    expect(screen.getByLabelText(/stub identity/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stub as google/i })).toBeEnabled();
  });

  it('signs in through the stub and reports the new session upward', async () => {
    const calls = installFetch({
      'POST /api/auth/mock/login': () => jsonResponse({ user: { id: 1 }, created: true }, 201),
    });
    const onSignedIn = vi.fn();
    renderScreen({ mockEnabled: true, onSignedIn });

    await userEvent.clear(screen.getByLabelText(/stub identity/i));
    await userEvent.type(screen.getByLabelText(/stub identity/i), 'grace');
    await userEvent.click(screen.getByRole('button', { name: /stub as google/i }));

    expect(onSignedIn).toHaveBeenCalled();
    expect(calls[0]?.body).toEqual({ provider: 'google', mock_user: 'grace' });
  });

  it('surfaces a failed stub sign-in instead of failing silently', async () => {
    installFetch({
      'POST /api/auth/mock/login': () =>
        jsonResponse({ error: { code: 'mock_auth_disabled', message: 'Mock SSO is disabled' } }, 404),
    });

    // LoginScreen is controlled: the error state lives with the caller, so the
    // harness wires onError back in exactly as App does.
    function Harness(): React.JSX.Element {
      const [error, setError] = useState<string | null>(null);
      return (
        <LoginScreen
          providers={bothConfigured}
          mockEnabled
          error={error}
          onError={setError}
          onSignedIn={vi.fn()}
        />
      );
    }
    render(<Harness />);

    await userEvent.click(screen.getByRole('button', { name: /stub as github/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Mock SSO is disabled');
  });

  it('renders an error handed down from the session bootstrap', () => {
    renderScreen({ error: 'Could not reach the backend.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the backend.');
  });
});
