package org.zermo.klaud

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import kotlin.concurrent.thread

class ReinClient {
    data class Result(val ok: Boolean, val text: String)

    fun ask(message: String, onUpdate: (String) -> Unit, onDone: (Result) -> Unit) {
        thread {
            try {
                if (!Prefs.reinReady()) {
                    onDone(Result(false, "Connect a Rein host in Setup."))
                    return@thread
                }
                val runId = UUID.randomUUID().toString()
                val body = JSONObject()
                    .put("runId", runId)
                    .put("threadId", "phone")
                    .put("message", message)
                    .put("tools", JSONArray())
                    .toString()
                val post = post("/v1/mobile/runs", body)
                if (post.code !in 200..299 && post.code != 202) {
                    onDone(Result(false, "Host ${post.code}: ${post.body.take(240)}"))
                    return@thread
                }
                val buf = StringBuilder()
                streamEvents(runId) { chunk ->
                    buf.append(chunk)
                    onUpdate(buf.toString())
                }
                val text = buf.toString().ifBlank { "Agent finished with no visible reply." }
                onDone(Result(true, text))
            } catch (e: Exception) {
                onDone(Result(false, e.message ?: "network error"))
            }
        }
    }

    private data class Http(val code: Int, val body: String)

    private fun post(path: String, json: String): Http {
        val url = URL(Prefs.host + path)
        val c = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 12_000
            readTimeout = 60_000
            doOutput = true
            setRequestProperty("Authorization", "Bearer ${Prefs.token}")
            setRequestProperty("Content-Type", "application/json")
        }
        c.outputStream.use { it.write(json.toByteArray()) }
        val code = c.responseCode
        val stream = if (code in 200..299) c.inputStream else c.errorStream
        val body = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
        c.disconnect()
        return Http(code, body)
    }

    private fun streamEvents(runId: String, onChunk: (String) -> Unit) {
        val url = URL("${Prefs.host}/v1/mobile/runs/$runId/events")
        val c = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 12_000
            readTimeout = 120_000
            setRequestProperty("Authorization", "Bearer ${Prefs.token}")
            setRequestProperty("Accept", "text/event-stream")
        }
        c.inputStream.bufferedReader().use { reader ->
            var data = StringBuilder()
            while (true) {
                val line = reader.readLine() ?: break
                when {
                    line.startsWith("data:") -> data.append(line.removePrefix("data:").trim())
                    line.isBlank() && data.isNotEmpty() -> {
                        val payload = data.toString()
                        data = StringBuilder()
                        extractText(payload)?.let(onChunk)
                        if (payload.contains("rein.run.done") || payload.contains("\"type\":\"done\"")) {
                            return
                        }
                    }
                }
            }
        }
        c.disconnect()
    }

    private fun extractText(payload: String): String? {
        return try {
            val obj = JSONObject(payload)
            val event = obj.optJSONObject("event") ?: obj
            val type = event.optString("type")
            when {
                type.contains("TEXT_MESSAGE_CONTENT", true) -> event.optString("delta").takeIf { it.isNotBlank() }
                event.has("delta") -> event.optString("delta").takeIf { it.isNotBlank() }
                else -> null
            }
        } catch (_: Exception) {
            null
        }
    }
}
