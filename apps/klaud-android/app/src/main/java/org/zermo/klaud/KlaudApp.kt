package org.zermo.klaud

import android.app.Application

class KlaudApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Prefs.init(this)
    }
}
