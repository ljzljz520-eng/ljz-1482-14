import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { useEffect } from "react";
import Layout from "./components/Layout";
import AudioVisual from "./pages/AudioVisual";
import Timeline from "./pages/Timeline";
import ParkOverview from "./pages/ParkOverview";
import ErrorBoundary from "./components/ErrorBoundary";
import LoginGate from "./components/LoginGate";
import { Toaster } from "react-hot-toast";
import { useAuthStore } from "./store/authStore";
import { setUnauthorizedHandler } from "./api/client";

const App = () => {
  const hydrated = useAuthStore((s) => s.hydrated);
  const user = useAuthStore((s) => s.user);
  const hydrate = useAuthStore((s) => s.hydrate);
  const logout = useAuthStore((s) => s.logout);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      logout();
    });
  }, [logout]);

  if (!hydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="h-10 w-10 rounded-full border-2 border-slate-200 border-t-primary animate-spin" />
      </div>
    );
  }

  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Layout>
          <Routes>
            <Route path="/" element={<ParkOverview />} />
            <Route
              path="/audiovisual"
              element={user ? <AudioVisual /> : <LoginGate />}
            />
            <Route path="/timeline" element={<Timeline />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
        <Toaster position="top-right" toastOptions={{ duration: 3500 }} />
      </ErrorBoundary>
    </BrowserRouter>
  );
};

export default App;
