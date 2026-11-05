package expo.modules.appdashattribution

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Install attribution inputs (Install Referrer). Filled in by Task 17.
class AppdashAttributionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AppdashAttribution")
  }
}
