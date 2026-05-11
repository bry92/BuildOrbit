import { useAuth } from "@/_core/hooks/useAuth";
import { Loader2 } from "lucide-react";
import { getLoginUrl } from "@/const";
import { Button } from "./ui/button";

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRole?: "user" | "admin";
}

export default function ProtectedRoute({ children, requiredRole }: ProtectedRouteProps) {
  const { user, loading, isAuthenticated } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center">
        <Loader2 className="animate-spin" size={48} />
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white flex flex-col items-center justify-center p-6">
        <div className="text-center max-w-md">
          <h1 className="text-5xl font-black tracking-tighter mb-4 text-red-600">ACCESS DENIED</h1>
          <p className="text-lg text-zinc-400 mb-8">You must be logged in to access this page.</p>
          <Button
            onClick={() => window.location.href = getLoginUrl()}
            className="bg-red-600 hover:bg-red-700 text-lg px-8 py-6 font-bold"
          >
            Login to Continue
          </Button>
        </div>
      </div>
    );
  }

  if (requiredRole && user.role !== requiredRole) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white flex flex-col items-center justify-center p-6">
        <div className="text-center max-w-md">
          <h1 className="text-5xl font-black tracking-tighter mb-4 text-red-600">FORBIDDEN</h1>
          <p className="text-lg text-zinc-400 mb-8">You don't have permission to access this page.</p>
          <Button
            onClick={() => window.location.href = "/"}
            className="bg-red-600 hover:bg-red-700 text-lg px-8 py-6 font-bold"
          >
            Back to Home
          </Button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
