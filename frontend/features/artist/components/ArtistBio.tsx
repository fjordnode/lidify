import { useMemo } from "react";

interface ArtistBioProps {
  bio: string;
}

export function ArtistBio({ bio }: ArtistBioProps) {
  // Process bio HTML to make all links open in new tabs
  const processedBio = useMemo(() => {
    if (!bio) return "";
    // Add target="_blank" and rel="noopener noreferrer" to all links
    return bio.replace(/<a\s+/gi, '<a target="_blank" rel="noopener noreferrer" ');
  }, [bio]);

  if (!bio) return null;

  return (
    <section>
      <h2 className="text-xl font-bold mb-4">About</h2>
      <div className="bg-white/5 rounded-md p-4">
        <div
          className="prose prose-sm md:prose-base prose-invert max-w-none leading-relaxed [&_a]:text-[#ecb200] [&_a]:no-underline [&_a:hover]:underline"
          style={{ color: '#b3b3b3' }}
          dangerouslySetInnerHTML={{ __html: processedBio }}
        />
      </div>
    </section>
  );
}
