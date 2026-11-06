import ExpoModulesCore
#if canImport(AdServices)
import AdServices
#endif
import AdSupport
import AppTrackingTransparency

private let zeroId = "00000000-0000-0000-0000-000000000000"

// Install attribution inputs: Apple AdServices token (no ATT consent required), plus the ATT status and, only when
// ATT is authorized, the IDFA. The module never shows the ATT prompt: the app does that.
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

    // "authorized" | "denied" | "restricted" | "notDetermined", or nil for a status this SDK does not know.
    AsyncFunction("getTrackingAuthorizationStatus") { () -> String? in
      switch ATTrackingManager.trackingAuthorizationStatus {
      case .authorized: return "authorized"
      case .denied: return "denied"
      case .restricted: return "restricted"
      case .notDetermined: return "notDetermined"
      @unknown default: return nil
      }
    }

    // The IDFA only when ATT is authorized; nil otherwise or when iOS returns the all-zero id.
    AsyncFunction("getAdvertisingId") { () -> String? in
      guard ATTrackingManager.trackingAuthorizationStatus == .authorized else { return nil }
      let id = ASIdentifierManager.shared().advertisingIdentifier.uuidString
      return id == zeroId ? nil : id
    }
  }
}
