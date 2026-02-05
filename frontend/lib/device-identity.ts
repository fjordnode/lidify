const LEGACY_DEVICE_ID_KEY = "lidify_device_id";
const BROWSER_ID_KEY = "lidify_browser_id";
const TAB_ID_KEY = "lidify_tab_id";

function generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function safeGetStorageItem(storage: Storage | null, key: string): string | null {
    if (!storage) return null;
    try {
        return storage.getItem(key);
    } catch {
        return null;
    }
}

function safeSetStorageItem(storage: Storage | null, key: string, value: string): void {
    if (!storage) return;
    try {
        storage.setItem(key, value);
    } catch {
        // ignore storage write failures
    }
}

function getLocalStorage(): Storage | null {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

function getSessionStorage(): Storage | null {
    if (typeof window === "undefined") return null;
    try {
        return window.sessionStorage;
    } catch {
        return null;
    }
}

export function getOrCreateBrowserId(): string {
    const storage = getLocalStorage();
    const storedBrowserId = safeGetStorageItem(storage, BROWSER_ID_KEY);
    if (storedBrowserId) return storedBrowserId;

    // Migrate legacy per-browser ID if present.
    const legacyId = safeGetStorageItem(storage, LEGACY_DEVICE_ID_KEY);
    const browserId = legacyId || generateId("browser");
    safeSetStorageItem(storage, BROWSER_ID_KEY, browserId);
    return browserId;
}

export function getOrCreateTabId(): string {
    const storage = getSessionStorage();
    const storedTabId = safeGetStorageItem(storage, TAB_ID_KEY);
    if (storedTabId) return storedTabId;

    const tabId = generateId("tab");
    safeSetStorageItem(storage, TAB_ID_KEY, tabId);
    return tabId;
}

export function getCurrentDeviceId(): string {
    const browserId = getOrCreateBrowserId();
    const tabId = getOrCreateTabId();

    // If sessionStorage is unavailable, fall back to browser-scoped ID.
    if (!tabId) return browserId;
    return `${browserId}:${tabId}`;
}

export function normalizeActivePlayerId(activePlayerId: string | null, currentDeviceId: string | null): string | null {
    if (!activePlayerId || !currentDeviceId) return activePlayerId;
    if (activePlayerId === currentDeviceId) return activePlayerId;

    // Legacy IDs were browser-scoped. Map local legacy value to this tab's device ID.
    const browserId = currentDeviceId.split(":")[0];
    if (activePlayerId === browserId) return currentDeviceId;

    return activePlayerId;
}
