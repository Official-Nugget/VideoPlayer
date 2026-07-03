/*
 * TMDB API helper.
 * All calls go directly to TMDB (their v3 API supports browser CORS).
 */

const TMDB = (() => {
  function buildUrl(path, params = {}) {
    const url = new URL(CONFIG.TMDB_BASE + path);
    // v3 key goes in the querystring; v4 token goes in the header instead.
    if (!CONFIG.TMDB_ACCESS_TOKEN) {
      url.searchParams.set("api_key", CONFIG.TMDB_API_KEY);
    }
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    });
    return url.toString();
  }

  async function request(path, params) {
    const headers = { accept: "application/json" };
    if (CONFIG.TMDB_ACCESS_TOKEN) {
      headers.Authorization = "Bearer " + CONFIG.TMDB_ACCESS_TOKEN;
    }
    const res = await fetch(buildUrl(path, params), { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`TMDB ${res.status}: ${body || res.statusText}`);
    }
    return res.json();
  }

  // --- Image helpers ---
  function img(pathPart, size = CONFIG.POSTER_SIZE) {
    if (!pathPart) return null;
    return `${CONFIG.IMG_BASE}/${size}${pathPart}`;
  }

  // --- Common endpoints ---
  const trending = (media = "all", window = "week") =>
    request(`/trending/${media}/${window}`);

  const popular = (media = "movie", page = 1) =>
    request(`/${media}/popular`, { page });

  const topRated = (media = "movie", page = 1) =>
    request(`/${media}/top_rated`, { page });

  const nowPlayingMovies = (page = 1) =>
    request(`/movie/now_playing`, { page });

  const airingTodayTV = (page = 1) => request(`/tv/airing_today`, { page });

  const byGenre = (media, genreId, page = 1) =>
    request(`/discover/${media}`, {
      with_genres: genreId,
      sort_by: "popularity.desc",
      page,
    });

  // Flexible discover for the search-filter bar.
  // opts: { genre, year, minRating, sortBy, page }
  const discover = (media, opts = {}) => {
    const params = {
      sort_by: opts.sortBy || "popularity.desc",
      page: opts.page || 1,
      include_adult: false,
      "vote_count.gte": opts.sortBy === "vote_average.desc" ? 200 : 0,
    };
    if (opts.genre) params.with_genres = opts.genre;
    if (opts.minRating) params["vote_average.gte"] = opts.minRating;
    if (opts.year) {
      if (media === "movie") params.primary_release_year = opts.year;
      else params.first_air_date_year = opts.year;
    }
    return request(`/discover/${media}`, params);
  };

  const genres = (media = "movie") => request(`/genre/${media}/list`);

  const recommendations = (media, id, page = 1) =>
    request(`/${media}/${id}/recommendations`, { page });

  const details = (media, id) =>
    request(`/${media}/${id}`, {
      append_to_response: "videos,credits,recommendations,external_ids",
    });

  const seasonDetails = (tvId, seasonNumber) =>
    request(`/tv/${tvId}/season/${seasonNumber}`);

  const search = (query, page = 1) =>
    request(`/search/multi`, { query, page, include_adult: false });

  return {
    request,
    img,
    trending,
    popular,
    topRated,
    nowPlayingMovies,
    airingTodayTV,
    byGenre,
    discover,
    genres,
    recommendations,
    details,
    seasonDetails,
    search,
  };
})();
