"use client";

import {
    createContext,
    useContext,
    useState,
    useCallback,
    ReactNode,
    useRef,
    useEffect,
} from "react";
import { CheckCircle2, XCircle, AlertCircle, Info, X } from "lucide-react";
import { cn } from "@/utils/cn";

type ToastType = "success" | "error" | "warning" | "info";

interface Toast {
    id: string;
    type: ToastType;
    message: string;
    action?: {
        label: string;
        onClick: () => void;
    };
}

interface ToastOptions {
    action?: {
        label: string;
        onClick: () => void;
    };
    duration?: number;
}

interface ToastContextType {
    toast: {
        success: (message: string, options?: ToastOptions) => void;
        error: (message: string, options?: ToastOptions) => void;
        warning: (message: string, options?: ToastOptions) => void;
        info: (message: string, options?: ToastOptions) => void;
    };
    /** Dismiss a toast by id and cancel its auto-dismiss timer */
    dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function useToast() {
    const context = useContext(ToastContext);
    if (!context) {
        throw new Error("useToast must be used within ToastProvider");
    }
    return context;
}

export type { ToastOptions };

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);
    const timeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

    const addToast = useCallback((type: ToastType, message: string, options?: ToastOptions) => {
        // Use a more unique ID that combines timestamp, counter, and random value
        const id = `${Date.now()}-${Math.random()
            .toString(36)
            .substring(2, 9)}`;

        setToasts((prev) => [...prev, { id, type, message, action: options?.action }]);

        // Auto-dismiss (default 5s, customizable via options)
        const duration = options?.duration ?? 5000;
        const timeoutId = setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== id));
            timeoutsRef.current.delete(id);
        }, duration);

        timeoutsRef.current.set(id, timeoutId);

        return id;
    }, []);

    const removeToast = useCallback((id: string) => {
        // Clear the timeout if toast is manually dismissed
        const timeoutId = timeoutsRef.current.get(id);
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutsRef.current.delete(id);
        }
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    // Cleanup all timeouts on unmount
    useEffect(() => {
        return () => {
            timeoutsRef.current.forEach((timeoutId) => {
                clearTimeout(timeoutId);
            });
            timeoutsRef.current.clear();
        };
    }, []);

    const toast = {
        success: (message: string, options?: ToastOptions) => addToast("success", message, options),
        error: (message: string, options?: ToastOptions) => addToast("error", message, options),
        warning: (message: string, options?: ToastOptions) => addToast("warning", message, options),
        info: (message: string, options?: ToastOptions) => addToast("info", message, options),
    };

    return (
        <ToastContext.Provider value={{ toast, dismissToast: removeToast }}>
            {children}

            {/* Toast Container */}
            <div className="fixed top-4 right-4 z-[100] flex flex-col-reverse gap-2 max-w-sm w-full px-4 md:px-0">
                {toasts.map((t) => (
                    <ToastItem
                        key={t.id}
                        toast={t}
                        onClose={() => removeToast(t.id)}
                    />
                ))}
            </div>
        </ToastContext.Provider>
    );
}

function ToastItem({ toast, onClose }: { toast: Toast; onClose: () => void }) {
    const icons = {
        success: CheckCircle2,
        error: XCircle,
        warning: AlertCircle,
        info: Info,
    };

    const styles = {
        success:
            "bg-gradient-to-br from-[#141414] to-[#0f0f0f] border-green-500/50 text-green-500",
        error: "bg-gradient-to-br from-[#141414] to-[#0f0f0f] border-red-500/50 text-red-500",
        warning:
            "bg-gradient-to-br from-[#141414] to-[#0f0f0f] border-yellow-500/50 text-yellow-500",
        info: "bg-gradient-to-br from-[#141414] to-[#0f0f0f] border-blue-500/50 text-blue-500",
    };

    const Icon = icons[toast.type];

    return (
        <div
            className={cn(
                "flex items-start gap-3 p-4 rounded-sm border shadow-2xl  animate-in slide-in-from-right duration-300",
                styles[toast.type]
            )}
        >
            <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div className="flex-1 flex items-center gap-3">
                <p className="flex-1 text-sm text-white font-medium">
                    {toast.message}
                </p>
                {toast.action && (
                    <button
                        onClick={() => {
                            toast.action!.onClick();
                            onClose();
                        }}
                        className="text-sm font-semibold text-brand hover:text-brand/80 transition-colors whitespace-nowrap"
                    >
                        {toast.action.label}
                    </button>
                )}
            </div>
            <button
                onClick={onClose}
                className="text-gray-400 hover:text-white transition-colors"
                aria-label="Close"
            >
                <X className="w-4 h-4" />
            </button>
        </div>
    );
}
