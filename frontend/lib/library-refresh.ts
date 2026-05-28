import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/useQueries";

export function refreshLibraryCaches(queryClient: QueryClient) {
    queryClient.invalidateQueries({ queryKey: queryKeys.library() });
    queryClient.invalidateQueries({ queryKey: ["albums"] });
    queryClient.invalidateQueries({ queryKey: ["album"] });
    queryClient.invalidateQueries({ queryKey: ["artist"] });
    queryClient.invalidateQueries({ queryKey: ["recommendations"] });

    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("library-data-changed"));
    }
}
