import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export type JobType = "scan" | "discover";

export interface JobStatus {
    status: "waiting" | "active" | "completed" | "failed" | "delayed";
    progress: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result?: any;
    error?: string;
}

export function useJobStatus(
    jobId: string | null,
    jobType: JobType,
    options?: {
        pollInterval?: number;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onComplete?: (result: any) => void;
        onError?: (error: string) => void;
    }
) {
    const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
    const [isPolling, setIsPolling] = useState(!!jobId);
    const pollInterval = options?.pollInterval || 5000;
    const [prevJobId, setPrevJobId] = useState(jobId);

    // Start polling when jobId changes from null to a value (React-approved setState during render)
    if (jobId !== prevJobId) {
        setPrevJobId(jobId);
        if (jobId && !isPolling) {
            setIsPolling(true);
        }
    }

    const checkStatus = useCallback(async () => {
        if (!jobId) return;

        try {
            let statusData;
            if (jobType === "scan") {
                statusData = await api.getScanStatus(jobId);
            } else if (jobType === "discover") {
                statusData = await api.getDiscoverGenerationStatus(jobId);
            }

            if (!statusData) return;

            setJobStatus(statusData as JobStatus);

            // Stop polling if job is complete or failed
            if (statusData.status === "completed") {
                setIsPolling(false);
                if (options?.onComplete && statusData.result) {
                    options.onComplete(statusData.result);
                }
            } else if (statusData.status === "failed") {
                setIsPolling(false);
                if (options?.onError) {
                    const errorMsg =
                        statusData.result?.error ||
                        "Job failed with unknown error";
                    options.onError(errorMsg);
                }
            }
        } catch (error: unknown) {
            console.error("Error checking job status:", error);
            setIsPolling(false);
            if (options?.onError) {
                const message = error instanceof Error ? error.message : "Failed to check job status";
                options.onError(message);
            }
        }
    }, [jobId, jobType, options]);

    // Poll for status updates
    useEffect(() => {
        if (!isPolling || !jobId) return;

        // Check shortly after mount (deferred to avoid synchronous setState in effect)
        const timeout = setTimeout(checkStatus, 0);

        // Then poll at interval
        const interval = setInterval(checkStatus, pollInterval);

        return () => {
            clearTimeout(timeout);
            clearInterval(interval);
        };
    }, [isPolling, jobId, checkStatus, pollInterval]);

    return {
        jobStatus,
        isPolling,
        checkStatus,
    };
}
