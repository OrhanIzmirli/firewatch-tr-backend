import axios, { AxiosInstance } from 'axios';

/**
 * Minimal client for NASA AppEEARS (https://appeears.earthdatacloud.nasa.gov/api/).
 *
 * AppEEARS is asynchronous: you submit an "area" task, poll it, then list
 * and download the files in its bundle. Everything here is a thin, typed
 * wrapper over those five calls; the policy (which months, what to do with
 * the rasters) lives in burnedAreaJob.
 *
 * Authentication is Earthdata Login username + password over HTTP Basic on
 * POST /login, which returns a Bearer token good for about 48 hours. An
 * Earthdata *user token* (the JWT from urs.earthdata.nasa.gov) is NOT
 * accepted here — that token is for direct downloads from CMR/LP DAAC.
 * Because a password is involved, the account should be a service account,
 * never a person's.
 *
 * Nothing here retries. A failed call surfaces to the job, which records it
 * and tries again on the next daily tick — AppEEARS outages are measured in
 * hours, not seconds.
 */

const BASE_URL = 'https://appeears.earthdatacloud.nasa.gov/api';

/** AppEEARS wants US-style dates. */
export function toAppeearsDate(d: Date): string {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}-${dd}-${d.getUTCFullYear()}`;
}

export interface AreaTaskLayer {
  product: string;
  layer: string;
}

export interface AreaTaskDateRange {
  startDate: string; // MM-DD-YYYY
  endDate: string; // MM-DD-YYYY
}

export interface AreaTaskRequest {
  taskName: string;
  dates: AreaTaskDateRange[];
  layers: AreaTaskLayer[];
  /** A GeoJSON FeatureCollection in EPSG:4326. */
  geo: unknown;
  /**
   * 'native' keeps the MODIS sinusoidal grid, in which every pixel has the
   * same ground area — the property the hectare arithmetic depends on.
   */
  projection?: 'native' | 'geographic';
}

export type TaskStatus = 'pending' | 'queued' | 'processing' | 'done' | 'error' | string;

export interface TaskStatusResponse {
  task_id: string;
  status: TaskStatus;
  progress?: { summary?: number };
  error?: unknown;
}

export interface BundleFile {
  file_id: string;
  file_name: string;
  file_size: number;
  file_type: string;
  sha256?: string;
}

export interface Credentials {
  username: string;
  password: string;
}

export function credentialsFromEnv(): Credentials | null {
  const username = process.env.EARTHDATA_USERNAME;
  const password = process.env.EARTHDATA_PASSWORD;
  if (!username || !password) return null;
  return { username, password };
}

export class AppeearsClient {
  private readonly http: AxiosInstance;
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly credentials: Credentials,
    baseUrl: string = BASE_URL
  ) {
    this.http = axios.create({ baseURL: baseUrl, timeout: 60_000 });
  }

  /** Returns a Bearer token, logging in when there is none or it is stale. */
  private async bearer(): Promise<string> {
    // Refresh an hour early; a task poll must not die on a token that
    // expires between the check and the call.
    if (this.token && Date.now() < this.tokenExpiresAt - 3_600_000) return this.token;

    const basic = Buffer.from(
      `${this.credentials.username}:${this.credentials.password}`
    ).toString('base64');
    const response = await this.http.post<{ token: string; expiration: string }>(
      '/login',
      null,
      { headers: { Authorization: `Basic ${basic}`, 'Content-Length': '0' } }
    );
    this.token = response.data.token;
    const expiration = Date.parse(response.data.expiration);
    this.tokenExpiresAt = Number.isFinite(expiration)
      ? expiration
      : Date.now() + 47 * 3_600_000;
    return this.token;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.bearer()}` };
  }

  async submitAreaTask(request: AreaTaskRequest): Promise<string> {
    const body = {
      task_type: 'area',
      task_name: request.taskName,
      params: {
        dates: request.dates.map((d) => ({ ...d, recurring: false })),
        layers: request.layers,
        geo: request.geo,
        output: {
          format: { type: 'geotiff' },
          projection: request.projection ?? 'native',
        },
      },
    };
    const response = await this.http.post<{ task_id: string; status: string }>(
      '/task',
      body,
      { headers: await this.authHeaders() }
    );
    if (!response.data?.task_id) {
      throw new Error('AppEEARS /task returned no task_id');
    }
    return response.data.task_id;
  }

  async getTaskStatus(taskId: string): Promise<TaskStatusResponse> {
    // /status/{id} is the lightweight progress view; /task/{id} carries the
    // definitive status once the task has left the queue. Prefer the latter
    // and fall back, because /status 404s for tasks that finished long ago.
    try {
      const response = await this.http.get<TaskStatusResponse>(`/task/${taskId}`, {
        headers: await this.authHeaders(),
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        const response = await this.http.get<TaskStatusResponse>(`/status/${taskId}`, {
          headers: await this.authHeaders(),
        });
        return response.data;
      }
      throw error;
    }
  }

  async listBundle(taskId: string): Promise<BundleFile[]> {
    const response = await this.http.get<{ files: BundleFile[] }>(`/bundle/${taskId}`, {
      headers: await this.authHeaders(),
    });
    return response.data.files ?? [];
  }

  /**
   * Downloads one bundle file into memory. AppEEARS answers with a 302 to a
   * pre-signed S3 URL; the redirect is followed WITHOUT the Bearer header,
   * because S3 rejects requests that carry a second Authorization.
   */
  async downloadFile(taskId: string, fileId: string): Promise<Buffer> {
    const first = await this.http.get(`/bundle/${taskId}/${fileId}`, {
      headers: await this.authHeaders(),
      maxRedirects: 0,
      responseType: 'arraybuffer',
      validateStatus: (s) => (s >= 200 && s < 300) || s === 302 || s === 303,
    });
    if (first.status === 302 || first.status === 303) {
      const location = first.headers['location'];
      if (!location) throw new Error('AppEEARS redirect without Location header');
      const second = await axios.get<ArrayBuffer>(location, {
        responseType: 'arraybuffer',
        timeout: 300_000,
        maxContentLength: 200 * 1024 * 1024,
      });
      return Buffer.from(second.data);
    }
    return Buffer.from(first.data as ArrayBuffer);
  }
}
