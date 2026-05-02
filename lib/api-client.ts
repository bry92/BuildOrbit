/**
 * API Client for BuildOrbit App Builder
 * Handles all communication with the backend API
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

interface ApiResponse<T> {
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  token?: string;
}

/**
 * Make an API request
 */
async function apiRequest<T>(
  endpoint: string,
  options: ApiRequestOptions = {}
): Promise<ApiResponse<T>> {
  const {
    method = 'GET',
    headers = {},
    body,
    token,
  } = options;

  const url = `${API_BASE_URL}${endpoint}`;

  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };

  if (token) {
    requestHeaders['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        error: data.error || {
          code: 'UNKNOWN_ERROR',
          message: 'An unknown error occurred',
        },
      };
    }

    return { data };
  } catch (err) {
    return {
      error: {
        code: 'NETWORK_ERROR',
        message: err instanceof Error ? err.message : 'Network request failed',
      },
    };
  }
}

/**
 * Get the stored JWT token
 */
function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('token');
}

// ============================================================================
// Authentication APIs
// ============================================================================

export interface SignupRequest {
  email: string;
  password: string;
  name: string;
  referral_code?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  id: string;
  email: string;
  name: string;
  credits: number;
  trial_ends_at: string;
  token: string;
}

export const authApi = {
  signup: (data: SignupRequest) =>
    apiRequest<AuthResponse>('/api/v1/auth/signup', {
      method: 'POST',
      body: data,
    }),

  login: (data: LoginRequest) =>
    apiRequest<AuthResponse>('/api/v1/auth/login', {
      method: 'POST',
      body: data,
    }),

  googleAuth: (token: string) =>
    apiRequest<AuthResponse>('/api/v1/auth/google', {
      method: 'POST',
      body: { token },
    }),

  githubAuth: (code: string) =>
    apiRequest<AuthResponse>('/api/v1/auth/github', {
      method: 'POST',
      body: { code },
    }),
};

// ============================================================================
// Builds APIs
// ============================================================================

export interface CreateBuildRequest {
  title: string;
  description: string;
  app_type: 'web' | 'mobile' | 'fullstack';
  complexity: 'simple' | 'moderate' | 'complex';
  template?: string;
  custom_config?: Record<string, unknown>;
}

export interface BuildPhase {
  phase_number: number;
  phase_name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  duration_ms?: number;
  output?: string;
  error_message?: string;
  started_at?: string;
  completed_at?: string;
}

export interface Build {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'planning' | 'scaffolding' | 'coding' | 'saving' | 'verifying' | 'completed' | 'failed';
  app_type: 'web' | 'mobile' | 'fullstack';
  complexity: 'simple' | 'moderate' | 'complex';
  current_phase: number;
  total_phases: number;
  progress_percentage: number;
  git_url?: string;
  download_url?: string;
  code_size_bytes?: number;
  credits_used: number;
  phases?: BuildPhase[];
  created_at: string;
  completed_at?: string;
}

export interface BuildsListResponse {
  total: number;
  builds: Build[];
}

export const buildsApi = {
  create: (data: CreateBuildRequest) => {
    const token = getToken();
    return apiRequest<Build>('/api/v1/builds', {
      method: 'POST',
      body: data,
      token: token || undefined,
    });
  },

  list: (params?: { status?: string; app_type?: string; limit?: number; offset?: number }) => {
    const token = getToken();
    const query = new URLSearchParams();
    if (params?.status) query.append('status', params.status);
    if (params?.app_type) query.append('app_type', params.app_type);
    if (params?.limit) query.append('limit', params.limit.toString());
    if (params?.offset) query.append('offset', params.offset.toString());

    const queryString = query.toString();
    const endpoint = `/api/v1/builds${queryString ? `?${queryString}` : ''}`;

    return apiRequest<BuildsListResponse>(endpoint, {
      token: token || undefined,
    });
  },

  get: (buildId: string) => {
    const token = getToken();
    return apiRequest<Build>(`/api/v1/builds/${buildId}`, {
      token: token || undefined,
    });
  },

  cancel: (buildId: string) => {
    const token = getToken();
    return apiRequest<{ id: string; status: string; message: string }>(
      `/api/v1/builds/${buildId}/cancel`,
      {
        method: 'POST',
        token: token || undefined,
      }
    );
  },

  download: async (buildId: string): Promise<Blob | null> => {
    const token = getToken();
    if (!token) return null;

    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/builds/${buildId}/download`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!response.ok) return null;
      return await response.blob();
    } catch {
      return null;
    }
  },

  streamProgress: (buildId: string, onMessage: (data: unknown) => void): WebSocket | null => {
    const token = getToken();
    if (!token) return null;

    const wsUrl = `${API_BASE_URL.replace('http', 'ws')}/api/v1/builds/${buildId}/stream?token=${token}`;
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onMessage(data);
      } catch {
        console.error('Failed to parse WebSocket message');
      }
    };

    return ws;
  },
};

// ============================================================================
// Credits APIs
// ============================================================================

export interface CreditTransaction {
  id: string;
  amount: number;
  type: 'signup' | 'referral' | 'purchase' | 'usage';
  description: string;
  build_id?: string;
  created_at: string;
}

export interface CreditsResponse {
  total_credits: number;
  transactions: CreditTransaction[];
}

export const creditsApi = {
  get: () => {
    const token = getToken();
    return apiRequest<CreditsResponse>('/api/v1/credits', {
      token: token || undefined,
    });
  },
};

// ============================================================================
// User APIs
// ============================================================================

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  credits: number;
  trial_ends_at: string;
  subscription_tier: string;
  referral_code: string;
  referral_count: number;
}

export const userApi = {
  getProfile: () => {
    const token = getToken();
    return apiRequest<UserProfile>('/api/v1/user', {
      token: token || undefined,
    });
  },

  updateProfile: (data: Partial<UserProfile>) => {
    const token = getToken();
    return apiRequest<UserProfile>('/api/v1/user', {
      method: 'PUT',
      body: data,
      token: token || undefined,
    });
  },
};

// ============================================================================
// Utility Functions
// ============================================================================

export function downloadFile(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  window.URL.revokeObjectURL(url);
  document.body.removeChild(a);
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

export function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
