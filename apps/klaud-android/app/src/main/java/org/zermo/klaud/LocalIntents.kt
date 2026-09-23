package org.zermo.klaud

import android.content.Context

object LocalIntents {
    fun handle(context: Context, spoken: String): String? {
        val t = spoken.lowercase().trim()
        if (t.isEmpty()) return null
        val wantsForward = listOf("forward", "send to personal", "send this to my other phone", "hand off", "handoff")
            .any { t.contains(it) }
        val wantsCancel = listOf("stop forwarding", "cancel forward", "keep calls here", "don't forward")
            .any { t.contains(it) }
        val wantsMail = t.contains("mail") || t.contains("inbox") || t.contains("email")
        val wantsCallPersonal = t.contains("call my personal") || t.contains("call personal")

        when {
            wantsCancel -> {
                if (!Prefs.lineReady()) return "Set your personal number in Line first."
                LineControl.place(context, LineControl.cancelUri())
                Prefs.forwardingOn = false
                return "Cancelling forwarding. Calls stay on this business line."
            }
            wantsForward -> {
                if (!Prefs.lineReady()) return "Set your personal number in Line first."
                LineControl.place(context, LineControl.forwardUri(Prefs.personalNumber))
                Prefs.forwardingOn = true
                return "Forwarding this business line to your personal phone."
            }
            wantsCallPersonal -> {
                if (!Prefs.lineReady()) return "Set your personal number in Line first."
                LineControl.place(context, LineControl.callPersonalUri(Prefs.personalNumber))
                return "Calling your personal line."
            }
            wantsMail -> return "MAIL"
        }
        return null
    }
}
