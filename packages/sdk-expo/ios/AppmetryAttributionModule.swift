import ExpoModulesCore
#if canImport(AdServices)
import AdServices
#endif

// Install attribution inputs: Apple AdServices token (no ATT consent required).
public class AppmetryAttributionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AppmetryAttribution")

    // Returns a Base64 token (24 h TTL) or nil when unavailable (e.g. simulator).
    AsyncFunction("getAdServicesToken") { () -> String? in
      #if canImport(AdServices)
      if #available(iOS 14.3, *) {
        do {
          return try AAAttribution.attributionToken()
        } catch {
          return nil
        }
      }
      #endif
      return nil
    }
  }
}
