"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppeearsClient = void 0;
exports.toAppeearsDate = toAppeearsDate;
exports.credentialsFromEnv = credentialsFromEnv;
const axios_1 = __importDefault(require("axios"));
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
function toAppeearsDate(d) {
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${mm}-${dd}-${d.getUTCFullYear()}`;
}
function credentialsFromEnv() {
    const username = process.env.EARTHDATA_USERNAME;
    const password = process.env.EARTHDATA_PASSWORD;
    if (!username || !password)
        return null;
    return { username, password };
}
class AppeearsClient {
    constructor(credentials, baseUrl = BASE_URL) {
        this.credentials = credentials;
        this.token = null;
        this.tokenExpiresAt = 0;
        this.http = axios_1.default.create({ baseURL: baseUrl, timeout: 60000 });
    }
    /** Returns a Bearer token, logging in when there is none or it is stale. */
    async bearer() {
        // Refresh an hour early; a task poll must not die on a token that
        // expires between the check and the call.
        if (this.token && Date.now() < this.tokenExpiresAt - 3600000)
            return this.token;
        const basic = Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString('base64');
        const response = await this.http.post('/login', null, { headers: { Authorization: `Basic ${basic}`, 'Content-Length': '0' } });
        this.token = response.data.token;
        const expiration = Date.parse(response.data.expiration);
        this.tokenExpiresAt = Number.isFinite(expiration)
            ? expiration
            : Date.now() + 47 * 3600000;
        return this.token;
    }
    async authHeaders() {
        return { Authorization: `Bearer ${await this.bearer()}` };
    }
    async submitAreaTask(request) {
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
        const response = await this.http.post('/task', body, { headers: await this.authHeaders() });
        if (!response.data?.task_id) {
            throw new Error('AppEEARS /task returned no task_id');
        }
        return response.data.task_id;
    }
    async getTaskStatus(taskId) {
        // /status/{id} is the lightweight progress view; /task/{id} carries the
        // definitive status once the task has left the queue. Prefer the latter
        // and fall back, because /status 404s for tasks that finished long ago.
        try {
            const response = await this.http.get(`/task/${taskId}`, {
                headers: await this.authHeaders(),
            });
            return response.data;
        }
        catch (error) {
            if (axios_1.default.isAxiosError(error) && error.response?.status === 404) {
                const response = await this.http.get(`/status/${taskId}`, {
                    headers: await this.authHeaders(),
                });
                return response.data;
            }
            throw error;
        }
    }
    async listBundle(taskId) {
        const response = await this.http.get(`/bundle/${taskId}`, {
            headers: await this.authHeaders(),
        });
        return response.data.files ?? [];
    }
    /**
     * Downloads one bundle file into memory. AppEEARS answers with a 302 to a
     * pre-signed S3 URL; the redirect is followed WITHOUT the Bearer header,
     * because S3 rejects requests that carry a second Authorization.
     */
    async downloadFile(taskId, fileId) {
        const first = await this.http.get(`/bundle/${taskId}/${fileId}`, {
            headers: await this.authHeaders(),
            maxRedirects: 0,
            responseType: 'arraybuffer',
            validateStatus: (s) => (s >= 200 && s < 300) || s === 302 || s === 303,
        });
        if (first.status === 302 || first.status === 303) {
            const location = first.headers['location'];
            if (!location)
                throw new Error('AppEEARS redirect without Location header');
            const second = await axios_1.default.get(location, {
                responseType: 'arraybuffer',
                timeout: 300000,
                maxContentLength: 200 * 1024 * 1024,
            });
            return Buffer.from(second.data);
        }
        return Buffer.from(first.data);
    }
}
exports.AppeearsClient = AppeearsClient;
