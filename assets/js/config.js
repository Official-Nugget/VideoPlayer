/*
 * ============================================================
 *  CONFIGURATION
 * ============================================================
 *  This site uses:
 *    - TMDB   -> for movie/TV metadata, posters, search, etc.
 *    - VidLink -> for the actual video streams (embedded player)
 *
 *  You MUST add a free TMDB API key for the site to work.
 *  Get one here (takes ~2 minutes, it's free):
 *      https://www.themoviedb.org/settings/api
 *
 *  You can use EITHER:
 *    1. A v3 API key (a short string), set TMDB_API_KEY below, or
 *    2. A v4 Read Access Token (long JWT), set TMDB_ACCESS_TOKEN below.
 *  If both are set, the v4 token is used.
 * ============================================================
 */

const CONFIG = {
  // --- TMDB credentials (fill at least one) ---
  TMDB_API_KEY: "d2f02526b2f5291c8bd037c737d003f5",
  TMDB_ACCESS_TOKEN: "", // optional: v4 "Read Access Token" (starts with eyJ...)

  // --- TMDB endpoints / images ---
  TMDB_BASE: "https://api.themoviedb.org/3",
  IMG_BASE: "https://image.tmdb.org/t/p",
  // poster sizes: w185 w342 w500 w780 original
  POSTER_SIZE: "w500",
  BACKDROP_SIZE: "original",

  // --- VidLink player ---
  VIDLINK_BASE: "https://vidlink.pro",
  VIDLINK_ORIGIN: "https://vidlink.pro",

  // --- Player look & feel (VidLink query params, hex WITHOUT '#') ---
  // Club Sandwich brand colors.
  PLAYER: {
    primaryColor: "ff9f1c",
    secondaryColor: "3a2a08",
    iconColor: "ffe0a3",
    icons: "default", // "default" | "vid"
    title: true,
    poster: true,
    nextbutton: true,
  },

  /*
   * --- Streaming sources (the "Source" dropdown in the player) ---
   * The first one is the default. VidLink sources support our brand colors +
   * resume; the others are TMDB-id based backups you can switch to if a stream
   * is missing or slow. Add/remove freely. Template placeholders:
   *   {id} {season} {episode}
   */
  SOURCES: [
    { id: "vidlink", name: "VidLink (recommended)", vidlink: true, engine: "default" },
    { id: "vidlink-jw", name: "VidLink · JW Player", vidlink: true, engine: "jw" },
    {
      id: "vidsrccc",
      name: "VidSrc.cc (backup)",
      movie: "https://vidsrc.cc/v2/embed/movie/{id}",
      tv: "https://vidsrc.cc/v2/embed/tv/{id}/{season}/{episode}",
    },
    {
      id: "vidsrcto",
      name: "VidSrc.to (backup)",
      movie: "https://vidsrc.to/embed/movie/{id}",
      tv: "https://vidsrc.to/embed/tv/{id}/{season}/{episode}",
    },
    {
      id: "2embed",
      name: "2Embed (backup)",
      movie: "https://www.2embed.cc/embed/{id}",
      tv: "https://www.2embed.cc/embedtv/{id}&s={season}&e={episode}",
    },
    {
      id: "autoembed",
      name: "AutoEmbed (backup)",
      movie: "https://player.autoembed.cc/embed/movie/{id}",
      tv: "https://player.autoembed.cc/embed/tv/{id}/{season}/{episode}",
    },
    {
      id: "embedapi",
      name: "Embed API (backup)",
      movie: "https://player.embed-api.stream/?id={id}",
      tv: "https://player.embed-api.stream/?id={id}&s={season}&e={episode}",
    },
  ],

  // --- Default playback settings (user can toggle these in the player) ---
  SETTINGS_DEFAULTS: {
    autoplay: true,
    resume: true, // resume from last watched position (VidLink only)
    rememberSource: true, // remember the last picked source
    autoNext: true, // auto-advance to the next episode when one ends (TV)
  },

  // --- localStorage keys ---
  LS_PROGRESS: "vidLinkProgress",
  LS_MYLIST: "myList",
  LS_SETTINGS: "csSettings",
  LS_SOURCE: "csSource",
  LS_RECENT: "csRecent",
};
