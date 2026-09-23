package org.zermo.klaud

import android.content.Context
import android.content.SharedPreferences

object Prefs {
    private lateinit var p: SharedPreferences

    fun init(context: Context) {
        p = context.applicationContext.getSharedPreferences("klaud", Context.MODE_PRIVATE)
    }

    var host: String
        get() = p.getString("host", "") ?: ""
        set(v) { p.edit().putString("host", v.trim().trimEnd('/')).apply() }

    var token: String
        get() = p.getString("token", "") ?: ""
        set(v) { p.edit().putString("token", v.trim()).apply() }

    var mailkitUrl: String
        get() = p.getString("mailkit", "") ?: ""
        set(v) { p.edit().putString("mailkit", v.trim().trimEnd('/')).apply() }

    var mailkitToken: String
        get() = p.getString("mailkit_token", "") ?: ""
        set(v) { p.edit().putString("mailkit_token", v.trim()).apply() }

    var personalNumber: String
        get() = p.getString("personal", "") ?: ""
        set(v) { p.edit().putString("personal", v.filter { it.isDigit() || it == '+' }).apply() }

    var forwardingOn: Boolean
        get() = p.getBoolean("fwd", false)
        set(v) { p.edit().putBoolean("fwd", v).apply() }

    fun reinReady(): Boolean = host.isNotBlank() && token.isNotBlank()
    fun mailReady(): Boolean = mailkitUrl.isNotBlank()
    fun lineReady(): Boolean = personalNumber.length >= 10
}
