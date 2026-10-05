import {
  useQuery,
  useMutation,
  useQueryClient
} from '@tanstack/react-query';
import { toast } from '@/components/ui/Toast';

const API_URL = import.meta.env.VITE_API_URL || '';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  const token = localStorage.getItem('offer-builder-token');
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  auth: {
    login: (email: string, password: string) =>
      request<{ user: any; token: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      }),
    me: () => request<any>('/api/auth/me'),
    logout: () => {
      localStorage.removeItem('offer-builder-token');
    },
  },

  offers: {
    list: () => request<any[]>('/api/offers'),
    get: (id: string) => request<any>(`/api/offers/${id}`),
    create: (data: any) =>
      request<any>('/api/offers', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: any) =>
      request<any>(`/api/offers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      request<void>(`/api/offers/${id}`, {
        method: 'DELETE',
      }),
    uploadLogo: async (file: File) => {
      const form = new FormData();
      form.append('logo', file, file.name);
      const headers: Record<string, string> = {};
      const token = localStorage.getItem('offer-builder-token');
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(`${API_URL}/api/offers/logo-upload`, {
        method: 'POST',
        headers,
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error || `Upload failed: ${res.status}`);
      }
      return res.json() as Promise<{ url: string }>;
    },
  },
  industries: {
    list: () => request<Array<{ key: string; label: string; urlKey?: string }>>('/api/industries'),
  },
  careers: {
    /** Slug + title of every agencyCareers row, for the funnel-type picker. */
    list: () =>
      request<Array<{ id: string; slug: string | null; title: string | null; status: string | null }>>(
        '/api/offers/careers',
      ),
  },
};

export function useCareers() {
  return useQuery({
    queryKey: ['careers'],
    queryFn: api.careers.list,
    staleTime: 5 * 60 * 1000,
  });
}

export function useOffers() {
  return useQuery({
    queryKey: ['offers'],
    queryFn: api.offers.list,
  });
}

export function useOffer(id: string | undefined) {
  return useQuery({
    queryKey: ['offer', id],
    queryFn: () => api.offers.get(id!),
    enabled: !!id,
  });
}

export function useUpdateOffer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) =>
      api.offers.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['offers'] });
      toast.success('Offer updated', 'Your changes have been saved.');
    },
    onError: (error: any) => {
      toast.error('Failed to update', error.message);
    },
  });
}

export function useDeleteOffer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.offers.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['offers'] });
      toast.success('Offer deleted', 'The offer has been removed.');
    },
    onError: (error: any) => {
      toast.error('Failed to delete', error.message);
    },
  });
}

export function useCreateOffer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: any) => api.offers.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['offers'] });
      toast.success('Offer created', 'Your new offer has been created.');
    },
    onError: (error: any) => {
      toast.error('Failed to create', error.message);
    },
  });
}
