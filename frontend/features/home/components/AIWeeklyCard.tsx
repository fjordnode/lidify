"use client";

import Link from "next/link";
import { Sparkles } from "lucide-react";

export function AIWeeklyCard() {
    return (
        <div className="flex-shrink-0 w-[160px] sm:w-[180px] p-3">
            <Link href="/ai-weekly">
                <div className="w-full aspect-square rounded-lg bg-gradient-to-br from-purple-600/20 to-pink-600/20 border border-purple-500/20 hover:border-purple-500/40 flex flex-col items-center justify-center p-4 mb-3 transition-all hover:scale-[1.02]">
                    <Sparkles className="w-10 h-10 text-purple-400 mb-2" />
                    <p className="text-xs text-gray-300 text-center">
                        AI-powered songs for you
                    </p>
                </div>
            </Link>
            <h3 className="text-sm font-medium text-white truncate">AI Weekly</h3>
            <p className="text-xs text-gray-400">Based on listening</p>
        </div>
    );
}
