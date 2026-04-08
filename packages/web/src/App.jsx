import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Spin } from 'antd';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { hasCap } from './components/AppLayout.jsx';

// Layouts
import AppLayout from './components/AppLayout.jsx';

// Auth pages
import LoginPage from './pages/auth/LoginPage.jsx';
import InviteAcceptPage from './pages/auth/InviteAcceptPage.jsx';
import ResetPasswordPage from './pages/auth/ResetPasswordPage.jsx';
import MfaSetupPage from './pages/auth/MfaSetupPage.jsx';

// App pages
import DashboardPage from './pages/DashboardPage.jsx';
import DocumentsPage from './pages/documents/DocumentsPage.jsx';
import NoticesPage from './pages/notices/NoticesPage.jsx';

// Admin pages
import UsersPage from './pages/admin/UsersPage.jsx';
import FundsPage from './pages/admin/FundsPage.jsx';
import AuditPage from './pages/admin/AuditPage.jsx';

// Settings pages
import ChangePasswordPage from './pages/settings/ChangePasswordPage.jsx';

/**
 * Route guard — redirects to /login if not authenticated.
 */
function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  return children;
}

/**
 * Capability-based route guard.
 * Checks the user has the specified capability (admin always passes).
 */
function CapRoute({ cap, children }) {
  const { user } = useAuth();
  if (!hasCap(user, cap)) return <Navigate to="/dashboard" replace />;
  return children;
}

/**
 * Redirect authenticated users away from login.
 */
function PublicRoute({ children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (user) return <Navigate to="/dashboard" replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      {/* Public routes */}
      <Route path="/login" element={<PublicRoute><LoginPage /></PublicRoute>} />
      <Route path="/invite/accept" element={<InviteAcceptPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      {/* Protected app routes */}
      <Route
        element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/notices" element={<NoticesPage />} />

        {/* Settings */}
        <Route path="/settings/mfa" element={<MfaSetupPage />} />
        <Route path="/settings/password" element={<ChangePasswordPage />} />

        {/* Capability-gated routes */}
        <Route path="/admin/users" element={<CapRoute cap="canManageUsers"><UsersPage /></CapRoute>} />
        <Route path="/admin/funds" element={<CapRoute cap="canManageFunds"><FundsPage /></CapRoute>} />
        <Route path="/admin/audit" element={<CapRoute cap="canViewAudit"><AuditPage /></CapRoute>} />
      </Route>

      {/* Fallback */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
