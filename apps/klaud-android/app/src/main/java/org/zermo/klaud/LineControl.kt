package org.zermo.klaud

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.content.ContextCompat

object LineControl {
    fun digits(raw: String): String = raw.filter { it.isDigit() }

    fun forwardUri(number: String): Uri {
        val n = digits(number)
        return Uri.fromParts("tel", "*21*$n#", null)
    }

    fun cancelUri(): Uri = Uri.fromParts("tel", "##21#", null)

    fun callPersonalUri(number: String): Uri {
        val n = digits(number)
        return Uri.fromParts("tel", n, null)
    }

    fun canCall(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) ==
            PackageManager.PERMISSION_GRANTED

    fun place(context: Context, uri: Uri) {
        val action = if (canCall(context)) Intent.ACTION_CALL else Intent.ACTION_DIAL
        context.startActivity(Intent(action, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
