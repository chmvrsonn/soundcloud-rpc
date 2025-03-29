const Store = require('electron-store');

import { app, BrowserWindow, dialog, Menu } from 'electron';
import { ElectronBlocker, fullLists } from '@cliqz/adblocker-electron';
import { readFileSync, writeFileSync } from 'fs';

import { DarkModeCSS } from './themes/dark';

import { ActivityType } from 'discord-api-types/v10';
import { Client as DiscordClient } from '@xhayper/discord-rpc';

import { authenticateLastFm, scrobbleTrack, updateNowPlaying, shouldScrobble, timeStringToSeconds } from './lastfm/lastfm';
import { setupLastFmConfig } from './lastfm/lastfm-auth';
import type { ScrobbleState } from './lastfm/lastfm';

import fetch from 'cross-fetch';
import { setupDarwinMenu } from './macos/menu';

const localShortcuts = require('electron-localshortcut');
const prompt = require('electron-prompt');
const clientId = '1090770350251458592';
const store = new Store();

export interface Info {
    rpc: DiscordClient;
    ready: boolean;
    autoReconnect: boolean;
}

const info: Info = {
    rpc: new DiscordClient({
        clientId,
    }),
    ready: false,
    autoReconnect: true,
};

info.rpc.login().catch(console.error);

let mainWindow: BrowserWindow | null;
let blocker: ElectronBlocker;
let currentScrobbleState: ScrobbleState | null = null;

async function init() {
    if (process.platform === "darwin")
        setupDarwinMenu();
    else
        Menu.setApplicationMenu(null);

    let bounds = store.get('bounds');
    let maximazed = store.get('maximazed');

    mainWindow = new BrowserWindow({
        width: bounds ? bounds.width : 1280,
        height: bounds ? bounds.height : 720,
        backgroundColor: store.get('darkMode') ? '#0b0c0c' : '#ffffff',
        webPreferences: {
            nodeIntegration: false,
        },
    });

    if (maximazed || !bounds) mainWindow.maximize();

    if (store.get('proxyEnabled')) {
        const { protocol, host } = store.get('proxyData');

        await mainWindow.webContents.session.setProxy({
            proxyRules: `${protocol}//${host}`,
        });
    }

    mainWindow.loadURL('https://soundcloud.com/discover');

    const executeJS = (script: string) => mainWindow.webContents.executeJavaScript(script);
    mainWindow.webContents.on('dom-ready', async () => {
        if (store.get('darkMode') && mainWindow.webContents.getURL().startsWith('https://soundcloud.com/')) {
            mainWindow.webContents.insertCSS(DarkModeCSS);
        }
    });

    mainWindow.webContents.on('did-finish-load', async () => {
        const apikey = store.get('lastFmApiKey');
        const secret = store.get('lastFmSecret');

        if (apikey && secret) {
            await authenticateLastFm(mainWindow, store);
            injectToastNotification('Last.fm authenticated');
        }

        if (store.get('adBlocker')) {
            const blocker = await ElectronBlocker.fromLists(
                fetch,
                fullLists,
                { enableCompression: true },
                {
                    path: 'engine.bin',
                    read: async (...args) => readFileSync(...args),
                    write: async (...args) => writeFileSync(...args),
                },
            );
            blocker.enableBlockingInSession(mainWindow.webContents.session);
        }

        setInterval(async () => {
            try {
                const isPlaying = await executeJS(`
                    document.querySelector('.playControls__play').classList.contains('playing')
                `);

                if (isPlaying) {
                    const trackInfo = await executeJS(`
                    new Promise(resolve => {
                        const titleEl = document.querySelector('.playbackSoundBadge__titleLink');
                        const authorEl = document.querySelector('.playbackSoundBadge__lightLink');
                        resolve({
                            title: titleEl?.innerText ?? '',
                            author: authorEl?.innerText ?? ''
                        });
                    });
                `);
                    if (!trackInfo.title || !trackInfo.author) {
                        console.log('Incomplete track info:', trackInfo);
                        return;
                    }

                    const currentTrack = {
                        author: trackInfo.author as string,
                        title: trackInfo.title
                            .replace(/.*?:\s*/, '')
                            .replace(/\n.*/, '')
                            .trim() as string,
                    };

                    const artworkUrl = await executeJS(`
                    new Promise(resolve => {
                        const artworkEl = document.querySelector('.playbackSoundBadge__avatar .image__lightOutline span');
                        resolve(artworkEl ? artworkEl.style.backgroundImage.slice(5, -2) : '');
                    });
                `);

                    const [elapsedTime, totalTime] = await Promise.all([
                        executeJS(
                            `document.querySelector('.playbackTimeline__timePassed span:last-child')?.innerText ?? ''`,
                        ),
                        executeJS(
                            `document.querySelector('.playbackTimeline__duration span:last-child')?.innerText ?? ''`,
                        ),
                    ]);

                    await updateNowPlaying(currentTrack, store);

                    const parseTime = (time: string): number => {
                        const parts = time.split(':').map(Number);
                        return parts.reduce((acc, part) => 60 * acc + part, 0);
                    };

                    const elapsedSeconds = parseTime(elapsedTime);
                    const totalSeconds = parseTime(totalTime);

                    if (currentScrobbleState) {
                        const previousElapsed = (Date.now() - currentScrobbleState.startTime) / 1000;
                        if (elapsedSeconds < previousElapsed - 10) {
                            console.log(`[Last.fm] Track loop detected - resetting scrobble state
                                Previous elapsed: ${Math.floor(previousElapsed)}s
                                Current elapsed: ${elapsedSeconds}s`);
                            currentScrobbleState = null;
                        }
                    }

                    if (
                        !currentScrobbleState ||
                        currentScrobbleState.artist !== currentTrack.author ||
                        currentScrobbleState.title !== currentTrack.title
                    ) {
                        if (
                            currentScrobbleState &&
                            !currentScrobbleState.scrobbled &&
                            shouldScrobble(currentScrobbleState)
                        ) {
                            await scrobbleTrack(
                                {
                                    author: currentScrobbleState.artist,
                                    title: currentScrobbleState.title,
                                },
                                store,
                            );
                        }

                        currentScrobbleState = {
                            artist: currentTrack.author,
                            title: currentTrack.title,
                            startTime: Date.now(),
                            duration: totalSeconds,
                            scrobbled: false,
                        };
                        console.log(`[Last.fm] New track detected: ${currentTrack.author} - ${currentTrack.title}`);
                    } else {
                        if (!currentScrobbleState.scrobbled && shouldScrobble(currentScrobbleState)) {
                            await scrobbleTrack(currentTrack, store);
                            currentScrobbleState.scrobbled = true;
                            console.log(`[Last.fm] Track scrobbled: ${currentTrack.author} - ${currentTrack.title}`);
                        }
                    }

                    if (!info.rpc.isConnected) {
                        if (await !info.rpc.login().catch(console.error)) {
                            return;
                        }
                    }

                    info.rpc.user?.setActivity({
                        type: ActivityType.Listening,
                        details: `${shortenString(currentTrack.title)}${(currentTrack.title.length < 2 ? '⠀⠀' : '')}`,
                        state: `${shortenString(trackInfo.author)}${(trackInfo.author.length < 2 ? '⠀⠀' : '')}`,
                        largeImageKey: artworkUrl.replace('50x50.', '500x500.'),
                        startTimestamp: Date.now() - elapsedSeconds * 1000,
                        endTimestamp: Date.now() + (totalSeconds - elapsedSeconds) * 1000,
                        instance: false,
                    });
                } else {
                    info.rpc.user?.setActivity({
                        type: ActivityType.Listening,
                        details: 'SoundCloud',
                        state: 'Paused',
                        largeImageKey: 'soundcloud-logo',
                        instance: false,
                    });
                }
            } catch (error) {
                console.error('Error during RPC update:', error);
            }
        }, 5000);
    });

    mainWindow.on('close', function () {
        store.set('bounds', mainWindow.getBounds());
        store.set('maximazed', mainWindow.isMaximized());
    });

    mainWindow.on('closed', function () {
        mainWindow = null;
    });

    localShortcuts.register(mainWindow, 'F1', () => toggleDarkMode());
    localShortcuts.register(mainWindow, 'F2', () => toggleAdBlocker());
    localShortcuts.register(mainWindow, 'F12', () => {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    });
    localShortcuts.register(mainWindow, 'F3', async () => toggleProxy());
    localShortcuts.register(mainWindow, 'F4', async () => {
        const apikey = store.get('lastFmApiKey');
        const secret = store.get('lastFmSecret');
        if (!apikey || !secret) {
            await setupLastFmConfig(mainWindow, store);
        } else {
            await authenticateLastFm(mainWindow, store);
            injectToastNotification('Last.fm authenticated');
        }
    });

    let zoomLevel = mainWindow.webContents.getZoomLevel();

    localShortcuts.register(mainWindow, 'CmdOrCtrl+=', () => {
        zoomLevel = Math.min(zoomLevel + 1, 9);
        mainWindow.webContents.setZoomLevel(zoomLevel);
    });

    localShortcuts.register(mainWindow, 'CmdOrCtrl+-', () => {
        zoomLevel = Math.max(zoomLevel - 1, -9);
        mainWindow.webContents.setZoomLevel(zoomLevel);
    });

    localShortcuts.register(mainWindow, 'CmdOrCtrl+0', () => {
        zoomLevel = 0;
        mainWindow.webContents.setZoomLevel(zoomLevel);
    });

    localShortcuts.register(mainWindow, ['CmdOrCtrl+B', 'CmdOrCtrl+P'], () => mainWindow.webContents.goBack());
    localShortcuts.register(mainWindow, ['CmdOrCtrl+F', 'CmdOrCtrl+N'], () => mainWindow.webContents.goForward());
}

app.on('ready', init);

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', function () {
    if (mainWindow === null) {
        init();
    }
});

function toggleAdBlocker() {
    const adBlockEnabled = store.get('adBlocker');
    store.set('adBlocker', !adBlockEnabled);

    if (adBlockEnabled) {
        if (blocker) blocker.disableBlockingInSession(mainWindow.webContents.session);
    }

    if (mainWindow) {
        mainWindow.reload();
        injectToastNotification(adBlockEnabled ? 'Adblocker disabled' : 'Adblocker enabled');
    }
}

app.on('login', async (_event, _webContents, _request, authInfo, callback) => {
    if (authInfo.isProxy) {
        if (!store.get('proxyEnabled')) {
            return callback('', '');
        }

        const { user, password } = store.get('proxyData');

        callback(user, password);
    }
});

async function toggleProxy() {
    const proxyUri = await prompt({
        title: 'Setup Proxy',
        label: "Enter 'off' to disable the proxy",
        value: 'http://user:password@ip:port',
        inputAttrs: {
            type: 'uri',
        },
        type: 'input',
    });

    if (proxyUri === null) return;

    if (proxyUri == 'off') {
        store.set('proxyEnabled', false);

        dialog.showMessageBoxSync(mainWindow, { message: 'The application needs to restart to work properly' });
        app.quit();
    } else {
        try {
            const url = new URL(proxyUri);
            store.set('proxyEnabled', true);
            store.set('proxyData', {
                protocol: url.protocol,
                host: url.host,
                user: url.username,
                password: url.password,
            });
            dialog.showMessageBoxSync(mainWindow, { message: 'The application needs to restart to work properly' });
            app.quit();
        } catch (e) {
            store.set('proxyEnabled', false);
            mainWindow.reload();
            injectToastNotification('Failed to setup proxy.');
        }
    }
}

function toggleDarkMode() {
    const darkModeEnabled = store.get('darkMode');
    store.set('darkMode', !darkModeEnabled);

    if (mainWindow) {
        mainWindow.reload();
        injectToastNotification(darkModeEnabled ? 'Dark mode disabled' : 'Dark mode enabled');
    }
}

function shortenString(str: string): string {
    return str.length > 128 ? str.substring(0, 128) + '...' : str;
}

export function injectToastNotification(message: string) {
    if (mainWindow) {
        mainWindow.webContents.executeJavaScript(`
      const notificationElement = document.createElement('div');
      notificationElement.style.position = 'fixed';
      notificationElement.style.bottom = '50px';
      notificationElement.style.fontSize = '20px';
      notificationElement.style.left = '50%';
      notificationElement.style.transform = 'translateX(-50%)';
      notificationElement.style.backgroundColor = '#1a1a1a';
      notificationElement.style.color = '#fff';
      notificationElement.style.padding = '10px 20px';
      notificationElement.style.borderRadius = '5px';
      notificationElement.style.opacity = '0'; 
      notificationElement.style.transition = 'opacity 0.5s';
      setTimeout(() => {
        notificationElement.style.opacity = '1';
      }, 100); 
      notificationElement.innerHTML = '${message}';
      document.body.appendChild(notificationElement);
      setTimeout(() => {
        notificationElement.style.opacity = '0';
        setTimeout(() => {
          notificationElement.remove();
        }, 500); 
      }, 4500);
    `);
    }
}
