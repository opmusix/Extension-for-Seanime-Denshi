declare interface Settings {
  episodeServers: string[];
  supportsDub: boolean;
}

declare interface SearchOptions {
  query: string;
  dub: boolean;
  media: {
    romajiTitle: string;
    englishTitle?: string;
    startDate?: {
      year: number;
      month: number;
      day: number;
    };
    format: string;
  };
}

declare interface SearchResult {
  id: string;
  title: string;
  url: string;
  subOrDub: string;
}

declare interface EpisodeDetails {
  id: string;
  number: number;
  url: string;
  title: string;
}

declare interface EpisodeServer {
  server: string;
  headers: Record<string, string>;
  videoSources: Array<{
    url: string;
    type: "m3u8" | "mp4";
    quality: string;
    subtitles?: Array<{
      id: string;
      language: string;
      url: string;
      isDefault: boolean;
    }>;
  }>;
}

declare interface VideoData {
  name: string;
  link: string;
  type: string;
}

declare interface Video {
  url: string;
  type: string;
  quality?: string;
}