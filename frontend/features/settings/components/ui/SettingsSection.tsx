import { ReactNode } from "react";

interface SettingsSectionProps {
    id: string;
    title: string;
    description?: string;
    children: ReactNode;
    showSeparator?: boolean;
}

export function SettingsSection({ 
    id, 
    title, 
    description, 
    children, 
    showSeparator = true 
}: SettingsSectionProps) {
    return (
        <section id={id} className="scroll-mt-24">
            <div className="mb-4">
                <h2 className="text-base font-semibold text-white">{title}</h2>
                {description && (
                    <p className="text-sm text-gray-400 mt-0.5">{description}</p>
                )}
            </div>
            
            <div className="space-y-1">
                {children}
            </div>
            
            {showSeparator && (
                <div className="border-t border-white/10 mt-8 mb-8" />
            )}
        </section>
    );
}

