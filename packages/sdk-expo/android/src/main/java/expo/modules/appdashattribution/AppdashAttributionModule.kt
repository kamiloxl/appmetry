package expo.modules.appdashattribution

import android.os.Handler
import android.os.Looper
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.atomic.AtomicBoolean

private const val TIMEOUT_MS = 10_000L

// Install attribution inputs: Play Install Referrer.
class AppdashAttributionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AppdashAttribution")

    // Resolves { referrer, clickTs, installTs } (seconds) or null. Never rejects.
    AsyncFunction("getInstallReferrer") { promise: Promise ->
      fetchInstallReferrer(promise)
    }
  }

  private fun fetchInstallReferrer(promise: Promise) {
    val context = appContext.reactContext?.applicationContext
    if (context == null) {
      promise.resolve(null)
      return
    }

    val done = AtomicBoolean(false)
    val handler = Handler(Looper.getMainLooper())
    var client: InstallReferrerClient? = null

    fun finish(value: Map<String, Any>?) {
      if (!done.compareAndSet(false, true)) return
      handler.removeCallbacksAndMessages(null)
      try {
        client?.endConnection()
      } catch (e: Exception) {
      }
      promise.resolve(value)
    }

    handler.postDelayed({ finish(null) }, TIMEOUT_MS)

    try {
      val c = InstallReferrerClient.newBuilder(context).build()
      client = c
      c.startConnection(object : InstallReferrerStateListener {
        override fun onInstallReferrerSetupFinished(responseCode: Int) {
          if (responseCode != InstallReferrerClient.InstallReferrerResponse.OK) {
            finish(null)
            return
          }
          try {
            val details = c.installReferrer
            finish(
              mapOf(
                "referrer" to details.installReferrer,
                "clickTs" to details.referrerClickTimestampSeconds.toDouble(),
                "installTs" to details.installBeginTimestampSeconds.toDouble()
              )
            )
          } catch (e: Exception) {
            finish(null)
          }
        }

        override fun onInstallReferrerServiceDisconnected() {
          // Service dropped before an answer; resolve null rather than wait for the timeout.
          finish(null)
        }
      })
    } catch (e: Exception) {
      finish(null)
    }
  }
}
