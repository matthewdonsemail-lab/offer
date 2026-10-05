import { BrowserRouter as Router, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ToastProvider } from '@/components/ui/Toast';
import { Layout } from '@/components/common/Layout';
import { LoginPage } from '@/pages/LoginPage';
import { CallbackPage } from '@/pages/CallbackPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { OffersPage } from '@/pages/OffersPage';
import { OfferDetailPage } from '@/pages/OfferDetailPage';
import { PreviewPage } from '@/pages/PreviewPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5 * 60 * 1000,
    },
  },
});

function AuthenticatedApp() {
  return (
    <Layout>
      <Routes>
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/offers" element={<OffersPage />} />
        <Route path="/offers/new" element={<OfferDetailPage />} />
        <Route path="/offers/:id" element={<OfferDetailPage />} />
        {/* Blueprint alias: internal builder surface */}
        <Route path="/admin/offers/:id" element={<OfferDetailPage />} />
        <Route path="*" element={<Navigate to="/offers" replace />} />
      </Routes>
    </Layout>
  );
}

/** Public funnel surface (offer.domain.com): no auth, no editor chrome. */
function PublicOfferRoute() {
  const { slug } = useParams<{ slug: string }>();
  return <PreviewPage mode="public" slug={slug || 'default'} />;
}

/** Industry pages: serves the offer linked to the prospect, or 404s. */
function PublicProspectRoute() {
  const { prospectKey } = useParams<{ prospectKey: string }>();
  return <PreviewPage mode="public" slug="default" key={prospectKey} />;
}

export function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return !!localStorage.getItem('offer-builder-token');
  });

  function handleLogin() {
    setIsAuthenticated(true);
  }

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Router>
          <Routes>
            <Route 
              path="/login" 
              element={<LoginPage />} 
            />
            <Route path="/callback" element={<CallbackPage onLogin={handleLogin} />} />
            <Route
              path="/preview/:industryId/:id"
              element={<PreviewPage />}
            />
            {/* Blueprint alias: embedded Twenty preview surface */}
            <Route
              path="/preview/offers/:id"
              element={<PreviewPage />}
            />
            {/* Blueprint: public funnel surface (offer.domain.com) */}
            <Route
              path="/offer"
              element={<PreviewPage mode="public" slug="default" />}
            />
            <Route
              path="/offer/:slug"
              element={<PublicOfferRoute />}
            />
            {/* Industry surface: prospect-linked offer or 404 */}
            <Route
              path="/offer/prospect/:prospectKey"
              element={<PublicProspectRoute />}
            />
            <Route 
              path="/*" 
              element={
                isAuthenticated ? (
                  <AuthenticatedApp />
                ) : (
                  <Navigate to="/login" replace />
                )
              } 
            />
          </Routes>
        </Router>
      </ToastProvider>
    </QueryClientProvider>
  );
}
