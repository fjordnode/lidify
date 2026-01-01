import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Trash2, Eye, EyeOff } from 'lucide-react';
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import { api } from "@/lib/api";

export const APIKeysSection: React.FC = () => {
  const [subsonicPassword, setSubsonicPassword] = useState('');
  const [hasSubsonicPassword, setHasSubsonicPassword] = useState(false);
  const [showSubsonicPassword, setShowSubsonicPassword] = useState(false);
  const [subsonicStatus, setSubsonicStatus] = useState<StatusType>("idle");
  const [subsonicMessage, setSubsonicMessage] = useState("");
  const [savingSubsonic, setSavingSubsonic] = useState(false);

  useEffect(() => {
    api.request<{ hasPassword: boolean }>('/auth/subsonic-password')
      .then(data => setHasSubsonicPassword(data.hasPassword))
      .catch(() => {});
  }, []);

  const handleSaveSubsonicPassword = async () => {
    if (!subsonicPassword.trim()) {
      setSubsonicStatus("error");
      setSubsonicMessage("Password required");
      return;
    }
    if (subsonicPassword.length < 4) {
      setSubsonicStatus("error");
      setSubsonicMessage("Min 4 characters");
      return;
    }

    setSavingSubsonic(true);
    setSubsonicStatus("loading");
    try {
      await api.request('/auth/subsonic-password', {
        method: 'POST',
        body: JSON.stringify({ password: subsonicPassword }),
      });
      setSubsonicStatus("success");
      setSubsonicMessage("Saved");
      setHasSubsonicPassword(true);
      setSubsonicPassword('');
    } catch (err: any) {
      setSubsonicStatus("error");
      setSubsonicMessage(err?.message || "Failed");
    }
    setSavingSubsonic(false);
  };

  const handleRemoveSubsonicPassword = async () => {
    setSavingSubsonic(true);
    try {
      await api.request('/auth/subsonic-password', { method: 'DELETE' });
      setHasSubsonicPassword(false);
      setSubsonicPassword('');
      setSubsonicStatus("success");
      setSubsonicMessage("Removed");
    } catch {
      setSubsonicStatus("error");
      setSubsonicMessage("Failed");
    }
    setSavingSubsonic(false);
  };

  return (
    <section id="api-keys" className="bg-[#111] rounded-lg p-6 scroll-mt-8">
      <div className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold text-white mb-2">Subsonic Password</h2>
          <p className="text-sm text-gray-400">
            Set a separate password for Subsonic-compatible apps like Symfonium, Supersonic, or Feishin.
          </p>
        </div>

        {hasSubsonicPassword ? (
          <div className="flex items-center gap-4">
            <span className="text-sm text-green-400">Password is set</span>
            <Button
              onClick={handleRemoveSubsonicPassword}
              variant="ghost"
              className="text-red-400 hover:text-red-300"
              disabled={savingSubsonic}
            >
              <Trash2 className="w-4 h-4 mr-1" />
              Remove
            </Button>
            <InlineStatus
              status={subsonicStatus}
              message={subsonicMessage}
              onClear={() => setSubsonicStatus("idle")}
            />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-2">
              <div className="relative flex-1 max-w-xs">
                <input
                  type={showSubsonicPassword ? "text" : "password"}
                  value={subsonicPassword}
                  onChange={(e) => setSubsonicPassword(e.target.value)}
                  placeholder="Enter Subsonic password"
                  className="w-full bg-[#0a0a0a] border border-[#1c1c1c] rounded-lg px-3 py-2 pr-10 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={() => setShowSubsonicPassword(!showSubsonicPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
                >
                  {showSubsonicPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <Button
                onClick={handleSaveSubsonicPassword}
                variant="primary"
                disabled={!subsonicPassword.trim() || savingSubsonic}
              >
                {savingSubsonic ? 'Saving...' : 'Save'}
              </Button>
            </div>
            <InlineStatus
              status={subsonicStatus}
              message={subsonicMessage}
              onClear={() => setSubsonicStatus("idle")}
            />
          </div>
        )}
      </div>
    </section>
  );
};
