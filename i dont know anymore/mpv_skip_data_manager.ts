/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

function init() {
    $ui.register((ctx) => {
        ctx.toast.info("MPV Skip Data Manager loaded")
        const lastPlayback = ctx.state("")
        const bridgeFile = "C:/Users/PC/AppData/Roaming/Seanime/logs/auto_skip-mpv-data.json"
        const settings = ctx.settings.define("config", {
            mainProvider: "aniskip",
            fallbackProvider: "theintrodb",
            fallbackEnabled: true,
        })

        function emptySkipData() {
            return { op: null, ed: null }
        }

        function hasSkipData(data: any) {
            return !!(data && (data.op || data.ed))
        }

        function sendToMpv(skipData: any) {
            try {
                $os.writeFile(bridgeFile, $toBytes(JSON.stringify(skipData)), 0644)
                console.log("[mpv-skip-data] wrote bridge data:", bridgeFile)
                return true
            } catch (error) {
                ctx.toast.warning("MPV Skip Data: bridge file write failed")
                console.error("[mpv-skip-data] bridge write failed:", error)
                return false
            }
        }

        async function fetchAniSkip(mediaId: number, episodeNumber: number) {
            try {
                const response = await ctx.fetch(
                    `https://api.aniskip.com/v2/skip-times/${mediaId}/${episodeNumber}`,
                )
                if (!response.ok) return null

                const payload = await response.json()
                if (!payload.found || !Array.isArray(payload.results)) return null

                const skipData = emptySkipData()
                for (const result of payload.results) {
                    const interval = result.interval
                    if (!interval || interval.endTime <= interval.startTime) continue
                    if (result.skip_type === "op") skipData.op = { interval }
                    if (result.skip_type === "ed") skipData.ed = { interval }
                }
                return hasSkipData(skipData) ? skipData : null
            } catch (error) {
                console.error("[mpv-skip-data] AniSkip request failed:", error)
                return null
            }
        }

        async function fetchAnimeKai(mediaId: number, episodeNumber: number) {
            try {
                const response = await ctx.fetch(
                    `https://enc-dec.app/db/kai/find?anilist_id=${mediaId}`,
                )
                if (!response.ok) return null

                const payload = await response.json()
                const animeData = Array.isArray(payload) ? payload[0] : payload
                if (!animeData || typeof animeData.episodes !== "object") return null

                let episodeData = null
                for (const groupKey of Object.keys(animeData.episodes)) {
                    const group = animeData.episodes[groupKey]
                    if (group && group[String(episodeNumber)]) {
                        episodeData = group[String(episodeNumber)]
                        break
                    }
                }

                const skip = episodeData?.sources?.sub?.skip
                if (!skip) return null

                const skipData = emptySkipData()
                if (Array.isArray(skip.intro) && skip.intro.length === 2) {
                    if (skip.intro[1] > skip.intro[0]) {
                        skipData.op = {
                            interval: { startTime: skip.intro[0], endTime: skip.intro[1] },
                        }
                    }
                }
                if (Array.isArray(skip.outro) && skip.outro.length === 2) {
                    if (skip.outro[1] > skip.outro[0]) {
                        skipData.ed = {
                            interval: { startTime: skip.outro[0], endTime: skip.outro[1] },
                        }
                    }
                }
                return hasSkipData(skipData) ? skipData : null
            } catch (error) {
                console.error("[mpv-skip-data] AnimeKai request failed:", error)
                return null
            }
        }

        async function fetchTheIntroDb(mediaId: number, episodeNumber: number) {
            try {
                const metadata = await ctx.anime.getAnimeMetadata("anilist", mediaId)
                const tmdbId = metadata?.mappings?.themoviedbId
                if (!tmdbId) return null

                const response = await ctx.fetch(
                    `https://api.theintrodb.org/v3/media?tmdb_id=${tmdbId}&season=1&episode=${episodeNumber}`,
                )
                if (!response.ok) return null

                const payload = await response.json()
                const skipData = emptySkipData()
                const intro = payload.intro?.[0]
                if (intro && intro.end_ms !== null && intro.end_ms !== undefined) {
                    const endTime = intro.end_ms / 1000
                    const startTime = intro.start_ms === null || intro.start_ms === undefined
                        ? 0
                        : intro.start_ms / 1000
                    if (endTime > startTime) {
                        skipData.op = { interval: { startTime, endTime } }
                    }
                }
                return hasSkipData(skipData) ? skipData : null
            } catch (error) {
                console.error("[mpv-skip-data] TheIntroDB request failed:", error)
                return null
            }
        }

        async function loadSkipData(mediaId: number, episodeNumber: number) {
            const mainProvider = settings.get("mainProvider", "aniskip")
            const fallbackProvider = settings.get("fallbackProvider", "animekai")
            const providers = [mainProvider]
            if (settings.get("fallbackEnabled", true) && fallbackProvider !== mainProvider) {
                providers.push(fallbackProvider)
            }

            for (const provider of providers) {
                let data = null
                if (provider === "animekai") data = await fetchAnimeKai(mediaId, episodeNumber)
                else if (provider === "theintrodb") data = await fetchTheIntroDb(mediaId, episodeNumber)
                else data = await fetchAniSkip(mediaId, episodeNumber)
                if (data) return data
            }
            return null
        }

        ctx.playback.registerEventListener(async (event) => {
            const stopped = event.isVideoStopped || event.isVideoCompleted || event.isStreamStopped || event.isStreamCompleted
            const started = !stopped && !!event.state?.mediaId && !!event.state?.episodeNumber && !!event.state?.filename
            if (started) {
                const mediaId = event.state?.mediaId
                const episodeNumber = event.state?.episodeNumber
                if (!mediaId || !episodeNumber) return

                const playbackKey = `${mediaId}:${episodeNumber}:${event.state.filename}`
                if (lastPlayback.get() === playbackKey) return
                lastPlayback.set(playbackKey)
                ctx.toast.info(`MPV Skip Data: detected episode ${episodeNumber}`)

                const skipData = await loadSkipData(mediaId, episodeNumber)
                if (!skipData) {
                    ctx.toast.warning("MPV Skip Data: no timings found")
                } else {
                    ctx.toast.success("MPV Skip Data: timings fetched")
                }
                sendToMpv(skipData || emptySkipData())
                return
            }

            if (stopped) {
                lastPlayback.set("")
                sendToMpv(emptySkipData())
            }
        })
    })
}
