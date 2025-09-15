import { useState, useEffect, useRef } from 'react';
import axios, { AxiosError } from 'axios';
import config from '../config';

interface UseApiDataOptions {
  pollingInterval?: number;
  enabled?: boolean;
}

interface UseApiDataResult<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

const API_BASE_URL = config.API_BASE_URL;

export function useApiData<T = unknown>(
  endpoint: string,
  options: UseApiDataOptions = {}
): UseApiDataResult<T> {
  const { pollingInterval = 5000, enabled = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = async () => {
    try {
      setError(null);
      const response = await axios.get<T>(`${API_BASE_URL}${endpoint}`, {
        withCredentials: true,
      });
      setData(response.data);
    } catch (err) {
      const axiosError = err as AxiosError<{ message?: string }>;
      setError(
        new Error(
          axiosError.response?.data?.message || 
          axiosError.message || 
          'Failed to fetch data'
        )
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }

    fetchData();

    if (pollingInterval > 0) {
      intervalRef.current = setInterval(fetchData, pollingInterval);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [endpoint, pollingInterval, enabled]);

  return { data, loading, error, refetch: fetchData };
}