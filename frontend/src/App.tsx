import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { SetupWizard } from './components/SetupWizard';
import { SplashScreen } from './components/SplashScreen';
import { AppShell } from './components/AppShell';
import { LoginPage } from './components/LoginPage';
import { ChangePasswordPage } from './components/ChangePasswordPage';
import { TwoFactorSetupPage } from './components/TwoFactorSetupPage';
import { PasskeySettingsPage } from './components/PasskeySettingsPage';
import { ThemeProvider } from './themes/ThemeContext';

type SetupStatus = 'checking' | 'required' | 'complete' | 'error';

function isAuthenticated(): boolean {
  // A lightweight presence check only — every API call still validates the
  // token server-side, so an expired/forged token here just means the first
  // API request from MainApp/AdminPanel fails and the person sees an error,
  // not a security boundary in itself.
  return !!sessionStorage.getItem('guac.sessionToken');
}

/** Wraps any route that requires a signed-in session. */
function RequireAuth({ children }: { children: JSX.Element }) {
  return isAuthenticated() ? children : <Navigate to="/login" replace />;
}

export function App() {
  const [setupStatus, setSetupStatus] = useState<SetupStatus>('checking');

  function checkSetupStatus() {
    setSetupStatus('checking');
    fetch('/api/setup/status')
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        return res.json();
      })
      .then((data) => setSetupStatus(data.setup_completed ? 'complete' : 'required'))
      // Deliberately NOT defaulting to 'complete' here (an earlier version
      // did, as a "fail safe" against trapping users behind a broken
      // check) — that was actually backwards: if this check fails because
      // the backend is still starting up or briefly unreachable, silently
      // assuming setup is done routes a brand-new install straight to a
      // login page with no account that will ever work, no explanation of
      // why. A real error state that says what's wrong and offers a retry
      // is the honest behavior, not a guess in either direction.
      .catch(() => setSetupStatus('error'));
  }

  useEffect(() => {
    checkSetupStatus();
  }, []);

  if (setupStatus === 'checking') return <SplashScreen />;

  if (setupStatus === 'error') {
    return (
      <div className="setup-status-error">
        <h1>Can't reach the server</h1>
        <p>
          The app couldn't check whether initial setup has been completed. This usually means the
          backend service isn't reachable yet — it may still be starting up, or something's wrong
          with the deployment.
        </p>
        <button onClick={checkSetupStatus}>Retry</button>
      </div>
    );
  }

  return (
    <ThemeProvider>
      <BrowserRouter>
      <Routes>
        <Route
          path="/setup"
          element={setupStatus === 'complete' ? <Navigate to="/login" replace /> : <SetupWizard />}
        />
        <Route
          path="/login"
          element={
            setupStatus === 'required' ? (
              <Navigate to="/setup" replace />
            ) : isAuthenticated() ? (
              <Navigate to="/" replace />
            ) : (
              <LoginPage />
            )
          }
        />
        <Route
          path="/change-password"
          element={
            <RequireAuth>
              <ChangePasswordPage />
            </RequireAuth>
          }
        />
        <Route
          path="/two-factor"
          element={
            <RequireAuth>
              <TwoFactorSetupPage />
            </RequireAuth>
          }
        />
        <Route
          path="/passkeys"
          element={
            <RequireAuth>
              <PasskeySettingsPage />
            </RequireAuth>
          }
        />
        <Route
          path="*"
          element={
            setupStatus === 'required' ? (
              <Navigate to="/setup" replace />
            ) : (
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            )
          }
        />
      </Routes>
      </BrowserRouter>
    </ThemeProvider>
  );
}
