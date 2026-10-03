import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import AudioVisual from "./pages/AudioVisual";
import Timeline from "./pages/Timeline";
import ParkOverview from "./pages/ParkOverview";
import ErrorBoundary from "./components/ErrorBoundary";
import { Toaster } from "react-hot-toast";

const App = () => {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Layout>
          <Routes>
            <Route path="/" element={<ParkOverview />} />
            <Route path="/audiovisual" element={<AudioVisual />} />
            <Route path="/timeline" element={<Timeline />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <Toaster position="top-right" />
        </Layout>
      </ErrorBoundary>
    </BrowserRouter>
  );
};

export default App;
