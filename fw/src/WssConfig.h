#pragma once
#include <string>
#include <cstdint>
#include <cctype>

namespace stackchan_fw {
struct WssConfig {
  std::string host, path, room, device;
  uint16_t port = 443;
};
inline bool validIdentifier(const std::string& s) {
  if (s.empty() || s.size() > 32 ||
      (!(s[0] >= 'a' && s[0] <= 'z') && !(s[0] >= '0' && s[0] <= '9'))) return false;
  for (char c : s) if (!(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9') && c != '_' && c != '-') return false;
  return true;
}
inline bool validDeviceToken(const std::string& s) {
  if (s.empty() || s.size() > 512) return false;
  for (unsigned char c : s) if (c <= 32 || c >= 127) return false;
  return true; // Prevent CR/LF header injection and accidental outer spaces.
}
inline bool parseWssConfig(const std::string& url, WssConfig& out) {
  if (url.size() > 1024 || url.compare(0, 6, "wss://") != 0) return false;
  const auto slash = url.find('/', 6);
  if (slash == std::string::npos) return false;
  WssConfig c;
  std::string authority = url.substr(6, slash - 6);
  auto colon = authority.find(':');
  c.host = authority.substr(0, colon);
  if (c.host.empty() || c.host.size() > 253 || c.host.front() == '.' || c.host.back() == '.') return false;
  for (unsigned char ch : c.host) if (!std::isalnum(ch) && ch != '.' && ch != '-') return false;
  if (colon != std::string::npos) {
    std::string port = authority.substr(colon + 1);
    if (port.empty() || port.size() > 5) return false;
    uint32_t n = 0;
    for (char ch : port) { if (ch < '0' || ch > '9') return false; n = n * 10 + ch - '0'; }
    if (n == 0 || n > 65535) return false;
    c.port = static_cast<uint16_t>(n);
  }
  c.path = url.substr(slash);
  if (c.path.compare(0, 11, "/ws/device?") != 0) return false;
  std::size_t pos = 11;
  while (pos < c.path.size()) {
    auto end = c.path.find('&', pos);
    if (end == std::string::npos) end = c.path.size();
    auto eq = c.path.find('=', pos);
    if (eq == std::string::npos || eq >= end) return false;
    auto key = c.path.substr(pos, eq - pos);
    auto value = c.path.substr(eq + 1, end - eq - 1);
    if (!validIdentifier(value)) return false;
    if (key == "room" && c.room.empty()) c.room = value;
    else if (key == "device_id" && c.device.empty()) c.device = value;
    else return false; // No duplicate keys, tokens in URLs, or unrecognized parameters.
    if (end + 1 == c.path.size()) return false;
    pos = end + 1;
  }
  if (c.room.empty() || c.device.empty()) return false;
  out = c;
  return true;
}
} // namespace stackchan_fw
