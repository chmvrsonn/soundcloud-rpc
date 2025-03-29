import { BrowserWindow } from 'electron';

import * as crypto from 'crypto';
import fetch from 'cross-fetch';
import type ElectronStore = require('electron-store');

export interface ScrobbleState {
    artist: string;
    title: string;
    startTime: number;
    duration: number;
    scrobbled: boolean;
}

function timeStringToSeconds(timeStr: string | undefined): number {
    if (!timeStr || typeof timeStr !== 'string') return 240; // Default to 4 minutes if no duration
    try {
        const [minutes, seconds] = timeStr.split(':').map(Number);
        return minutes * 60 + (seconds || 0);
    } catch (error) {
        console.error('Error parsing time string:', error);
        return 240; // Default to 4 minutes on error
    }
}
function shouldScrobble(state: ScrobbleState): boolean {
    const playedTime = (Date.now() - state.startTime) / 1000;
    const minimumTime = 30;

    console.log(`[Last.fm] Scrobble Check:
    - Track: ${state.artist} - ${state.title}
    - Played time: ${Math.floor(playedTime)}s
    - Required time: ${Math.floor(minimumTime)}s
    - Already scrobbled: ${state.scrobbled}
    `);

    return !state.scrobbled && playedTime >= minimumTime;
}

async function authenticateLastFm(mainWindow: BrowserWindow, store: ElectronStore): Promise<void> {
    const lastFmSessionKey = store.get('lastFmSessionKey');
    if (lastFmSessionKey) {
        return; // Already authenticated
    }

    const apiKey = store.get('lastFmApiKey') as string;
    if (!apiKey) {
        console.error('No Last.fm API key found');
        return;
    }

    // Create a new window for Last.fm authentication
    const authWindow = new BrowserWindow({
        width: 800,
        height: 600,
        title: 'Last.fm Authentication',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            webviewTag: true,
            sandbox: false,
            devTools: true,
            partition: 'persist:lastfm-auth'
        }
    });

    // Set user agent to avoid potential issues with Last.fm's website
    authWindow.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Enable remote module for debugging if needed
    authWindow.webContents.openDevTools();

    // Use the official Last.fm auth URL with proper format
    const authUrl = `http://www.last.fm/api/auth?api_key=${apiKey}`;

    try {
        await authWindow.loadURL(authUrl);

        // Handle navigation events
        authWindow.webContents.on('did-navigate', async (_, url) => {
            try {
                const urlObj = new URL(url);
                const token = urlObj.searchParams.get('token');
                if (token) {
                    await getLastFmSession(apiKey, token, store);
                    authWindow.close();
                    mainWindow.loadURL('https://soundcloud.com/discover');
                }
            } catch (error) {
                console.error('Error during Last.fm navigation:', error);
            }
        });

        // Handle navigation to different origins
        authWindow.webContents.on('will-navigate', (event, url) => {
            const urlObj = new URL(url);
            // Allow navigation to Last.fm domains
            if (!urlObj.hostname.includes('last.fm')) {
                event.preventDefault();
            }
        });

        // Handle errors
        authWindow.webContents.on('did-fail-load', (_, errorCode, errorDescription, validatedURL) => {
            // Ignore errors for canceled requests
            if (errorCode === -3) return;
            
            console.error('Failed to load:', validatedURL);
            console.error('Error code:', errorCode);
            console.error('Description:', errorDescription);
        });

        // Handle window close
        authWindow.on('closed', () => {
            // Clean up event listeners
            authWindow.webContents.removeAllListeners('did-navigate');
            authWindow.webContents.removeAllListeners('will-navigate');
            authWindow.webContents.removeAllListeners('did-fail-load');
        });

    } catch (error) {
        console.error('Error during Last.fm authentication setup:', error);
        authWindow.close();
    }
}

// After the user logs in, retrieve and store the session key
async function getLastFmSession(api_key: string, token: string, store: ElectronStore) {
    const lastFmSecret = store.get('lastFmSecret');
    const apiSig = generateApiSignature(
        {
            method: 'auth.getSession',
            api_key,
            token,
        },
        lastFmSecret as string,
    );

    const response = await fetch(
        `https://ws.audioscrobbler.com/2.0/?method=auth.getSession&api_key=${api_key}&token=${token}&api_sig=${apiSig}&format=json`,
    );
    const data = await response.json();
    if (data.error) {
        console.error(data.message);
        return;
    }
    store.set('lastFmSessionKey', data.session.key); // Store the session key
}

function generateApiSignature(
    params: {
        [x: string]: string | undefined;
        method?: string;
        api_key?: string;
        token?: string;
    },
    secret: string,
): string {
    const sortedParams =
        Object.keys(params)
            .sort()
            .map((key) => `${key}${params[key]}`)
            .join('') + secret;
    return crypto.createHash('md5').update(sortedParams, 'utf8').digest('hex');
}

async function scrobbleTrack(trackInfo: { author: string; title: string }, store: ElectronStore): Promise<void> {
    console.log(`[Last.fm] Attempting to scrobble: ${trackInfo.author} - ${trackInfo.title}`);
    
    const sessionKey = store.get('lastFmSessionKey');
    if (!sessionKey) {
        console.error('[Last.fm] No session key found - not authenticated');
        return;
    }
    const apiKey = store.get('lastFmApiKey') as string;
    const secretKey = store.get('lastFmSecret') as string;
    if (!apiKey || !secretKey) {
        console.error('[Last.fm] Missing API key or secret');
        return;
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const params = {
        method: 'track.scrobble',
        api_key: apiKey,
        sk: sessionKey as string,
        artist: trackInfo.author,
        track: trackInfo.title,
        timestamp: timestamp.toString(),
    };
    const apiSig = generateApiSignature(params, secretKey);
    try {
        console.log('[Last.fm] Sending scrobble request...');
        const response = await fetch(`https://ws.audioscrobbler.com/2.0/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                ...params,
                api_sig: apiSig,
                format: 'json',
            }),
        });

        const data = await response.json();
        if (data.error) {
            console.error('[Last.fm] Scrobble failed:', data.message);
        } else {
            console.log(`[Last.fm] ✓ Successfully scrobbled: ${trackInfo.author} - ${trackInfo.title}`);
        }
    } catch (error) {
        console.error('[Last.fm] Failed to scrobble track:', error);
    }
}

const trackChanged = (current: any, previous: any): boolean => {
    if (!previous) return true;
    return current.artist !== previous.artist || current.title !== previous.title;
};

async function updateNowPlaying(trackInfo: { author: any; title: any }, store: ElectronStore): Promise<void> {
    console.log(`[Last.fm] Updating now playing: ${trackInfo.author} - ${trackInfo.title}`);
    
    const sessionKey = store.get('lastFmSessionKey');
    if (!sessionKey) {
        console.log('[Last.fm] No session key found - skipping now playing update');
        return;
    }
    const apiKey = store.get('lastFmApiKey') as string;
    const secretKey = store.get('lastFmSecret') as string;
    if (!apiKey || !secretKey) {
        console.error('[Last.fm] Missing API key or secret');
        return;
    }

    const params = {
        method: 'track.updateNowPlaying',
        api_key: apiKey,
        sk: sessionKey as string,
        artist: trackInfo.author,
        track: trackInfo.title,
    };

    const apiSig = generateApiSignature(params, secretKey);
    try {
        const response = await fetch(`https://ws.audioscrobbler.com/2.0/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                ...params,
                api_sig: apiSig,
                format: 'json',
            }),
        });

        const data = await response.json();
        if (data.error) {
            console.error('[Last.fm] Now playing update failed:', data.message);
        } else {
            console.log(`[Last.fm] ✓ Now playing updated: ${trackInfo.author} - ${trackInfo.title}`);
        }
    } catch (e) {
        console.error('[Last.fm] Failed to update now playing:', e);
    }
}

export {
    authenticateLastFm,
    getLastFmSession,
    scrobbleTrack,
    updateNowPlaying,
    trackChanged,
    shouldScrobble,
    timeStringToSeconds,
    generateApiSignature,
};
