import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Spin } from 'antd';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { hasCap } from './components/AppLayout.jsx';

// Layouts
import AppLayout from './components/AppLayout.jsx';
import CompanyLayout from './components/CompanyLayout.jsx';

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
import PipelinePage from './pages/admin/PipelinePage.jsx';
import CompanyDetailPage from './pages/admin/CompanyDetailPage.jsx';
import ReviewQueuePage from './pages/admin/ReviewQueuePage.jsx';

// Company portal pages
import WorkspacePage from './pages/company/WorkspacePage.jsx';
import ItemDetailPage from './pages/company/ItemDetailPage.jsx';
import StagedSubmissionPage from './pages/company/StagedSubmissionPage.jsx';
import ReceiptsPage from './pages/company/ReceiptsPage.jsx';
import TeamPage from './pages/company/TeamPage.jsx';

// Settings pages
import ChangePasswordPage from './pages/settings/ChangePasswordPage.jsx';

function FullPageSpinner() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <Spin size="large" />
    </div>
  );
}

/**
 * Route guard — redirects to /login if not authenticated.
 */
function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();

  if (loading) return <FullPageSpinner />;
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
 * Company portal guard. Role 'company' and nothing else.
 *
 * The opposite guard is FundRoute below. Between them, neither side can reach
 * the other's shell by typing a URL, which mirrors what the API middleware
 * enforces server-side.
 */
function CompanyRoute({ children }) {
  const { user } = useAuth();
  if (user?.role !== 'company') return <Navigate to="/dashboard" replace />;
  return children;
}

function FundRoute({ children }) {
  const { user } = useAuth();
  if (user?.role === 'company') return <Navigate to="/company" replace />;
  return children;
}

/**
 * Redirect authenticated users away from login, to whichever side they belong.
 */
function PublicRoute({ children }) {
  const { user, loading } = useAuth();

  if (loading) return <FullPageSpinner />;
  if (user) return <Navigate to={user.role === 'company' ? '/company' : '/dashboard'} replace />;
  return children;
}

function AppRoutes() {
  const { user, loading } = useAuth();

  // Mandatory MFA for the company role. A user in this state holds a token that
  // reaches the enrolment endpoints and nothing else, so there is no point
  // rendering anything but enrolment: every other request would be refused.
  if (!loading && user?.mfaEnrolmentRequired) {
    return (
      <Routes>
        <Route path="*" element={<MfaSetupPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      {/* Public routes */}
      <Route path="/login" element={<PublicRoute><LoginPage /></PublicRoute>} />
      <Route path="/invite/accept" element={<InviteAcceptPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />

      {/* Company portal. Nothing fund-related is mounted under this shell. */}
      <Route
        element={
          <ProtectedRoute>
            <CompanyRoute>
              <CompanyLayout />
            </CompanyRoute>
          </ProtectedRoute>
        }
      >
        <Route path="/company" element={<WorkspacePage />} />
        <Route path="/company/items/:itemId" element={<ItemDetailPage />} />
        <Route path="/company/staged" element={<StagedSubmissionPage />} />
        <Route path="/company/receipts" element={<ReceiptsPage />} />
        <Route path="/company/team" element={<TeamPage />} />
      </Route>

      {/* Protected app routes */}
      <Route
        element={
          <ProtectedRoute>
            <FundRoute>
              <AppLayout />
            </FundRoute>
          </ProtectedRoute>
        }
      >
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/notices" element={<NoticesPage />} />

        {/* Capability-gated routes */}
        <Route path="/admin/users" element={<CapRoute cap="canManageUsers"><UsersPage /></CapRoute>} />
        <Route path="/admin/funds" element={<CapRoute cap="canManageFunds"><FundsPage /></CapRoute>} />
        <Route path="/admin/audit" element={<CapRoute cap="canViewAudit"><AuditPage /></CapRoute>} />

        {/* Due diligence, Taranis side. Assigned reviewers reach these too, and
            the API scopes each one to the companies they are assigned to. */}
        <Route path="/admin/companies" element={<PipelinePage />} />
        <Route path="/admin/companies/:companyId" element={<CompanyDetailPage />} />
        <Route path="/admin/review-queue" element={<ReviewQueuePage />} />
      </Route>

      {/* Settings, available to both shells */}
      <Route
        element={<ProtectedRoute>{user?.role === 'company' ? <CompanyLayout /> : <AppLayout />}</ProtectedRoute>}
      >
        <Route path="/settings/mfa" element={<MfaSetupPage />} />
        <Route path="/settings/password" element={<ChangePasswordPage />} />
      </Route>

      {/* Fallback */}
      <Route
        path="*"
        element={<Navigate to={user?.role === 'company' ? '/company' : '/dashboard'} replace />}
      />
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
