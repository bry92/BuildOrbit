import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import KillMode from "./pages/KillMode";
import ImageToVideo from "./pages/ImageToVideo";
import Studio from "./pages/Studio";
import Capture from "./pages/Capture";
import SwarmTraining from "./pages/SwarmTraining";
import Gallery from "./pages/Gallery";
import ProtectedRoute from "./components/ProtectedRoute";

function Router() {
  // make sure to consider if you need authentication for certain routes
  return (
    <Switch>
      <Route path={"\\"} component={Home} />
      <Route path="/kill-mode" component={() => <ProtectedRoute><KillMode /></ProtectedRoute>} />
      <Route path="/image-to-video" component={() => <ProtectedRoute><ImageToVideo /></ProtectedRoute>} />
      <Route path="/studio" component={() => <ProtectedRoute><Studio /></ProtectedRoute>} />
      <Route path="/capture" component={() => <ProtectedRoute><Capture /></ProtectedRoute>} />
      <Route path="/swarm" component={() => <ProtectedRoute><SwarmTraining /></ProtectedRoute>} />
      <Route path="/gallery" component={() => <ProtectedRoute><Gallery /></ProtectedRoute>} />
      <Route path="/404" component={NotFound} />
      {/* Final fallback route */}
      <Route component={NotFound} />
    </Switch>
  );
}

// NOTE: About Theme
// - First choose a default theme according to your design style (dark or light bg), than change color palette in index.css
//   to keep consistent foreground/background color across components
// - If you want to make theme switchable, pass `switchable` ThemeProvider and use `useTheme` hook

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="light"
        // switchable
      >
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
