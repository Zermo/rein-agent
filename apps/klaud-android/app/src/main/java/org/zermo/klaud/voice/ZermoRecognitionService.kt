package org.zermo.klaud.voice

import android.content.Intent
import android.speech.RecognitionService
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

class ZermoRecognitionService : RecognitionService() {
    private var recognizer: SpeechRecognizer? = null

    override fun onStartListening(recognizerIntent: Intent, listener: Callback) {
        val r = SpeechRecognizer.createSpeechRecognizer(this)
        recognizer = r
        r.setRecognitionListener(CallbackListener(listener))
        val intent = recognizerIntent.apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        }
        r.startListening(intent)
    }

    override fun onCancel(listener: Callback) {
        recognizer?.cancel()
    }

    override fun onStopListening(listener: Callback) {
        recognizer?.stopListening()
    }

    override fun onDestroy() {
        recognizer?.destroy()
        super.onDestroy()
    }

    private class CallbackListener(private val cb: Callback) : android.speech.RecognitionListener {
        override fun onReadyForSpeech(params: android.os.Bundle?) = cb.beginningOfSpeech()
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) = cb.rmsChanged(rmsdB)
        override fun onBufferReceived(buffer: ByteArray?) = cb.bufferReceived(buffer)
        override fun onEndOfSpeech() = cb.endOfSpeech()
        override fun onError(error: Int) = cb.error(error)
        override fun onResults(results: android.os.Bundle) = cb.results(results)
        override fun onPartialResults(partialResults: android.os.Bundle) = cb.partialResults(partialResults)
        override fun onEvent(eventType: Int, params: android.os.Bundle?) {}
    }
}
