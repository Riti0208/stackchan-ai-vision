#include "../src/WssConfig.h"
#include <cassert>
#include <iostream>
using namespace stackchan_fw;
int main() {
  WssConfig c;
  assert(parseWssConfig("wss://robot.example/ws/device?room=main&device_id=stackchan-01", c));
  assert(c.host=="robot.example" && c.port==443 && c.room=="main" && c.device=="stackchan-01");
  assert(parseWssConfig("wss://robot.example:8443/ws/device?device_id=a&room=b", c));
  assert(c.port==8443 && c.device=="a" && c.room=="b");
  for (const char* url : {
      "ws://robot.example/ws/device?room=main&device_id=a",
      "wss://<DOMAIN>/ws/device?room=main&device_id=a",
      "wss://user:pass@robot.example/ws/device?room=main&device_id=a",
      "wss://robot.example:65536/ws/device?room=main&device_id=a",
      "wss://robot.example:0/ws/device?room=main&device_id=a",
      "wss://robot.example:4x/ws/device?room=main&device_id=a",
      "wss://robot.example/ws/viewer?room=main&device_id=a",
      "wss://robot.example/ws/device?room=main",
      "wss://robot.example/ws/device?room=main&device_id=a&room=other",
      "wss://robot.example/ws/device?room=main&device_id=a&token=secret",
      "wss://robot.example/ws/device?room=main&device_id=a&",
      "wss://robot.example/ws/device?room=main&device_id=a#fragment",
      "wss://robot.example/ws/device?room=Main&device_id=a",
      "wss://robot.example\r\nInjected:x/ws/device?room=main&device_id=a"}) {
    assert(!parseWssConfig(url,c));
  }
  assert(validDeviceToken("test-device-token_01"));
  assert(!validDeviceToken(""));
  assert(!validDeviceToken(" token"));
  assert(!validDeviceToken("token\r\nInjected: x"));
  assert(!validDeviceToken(std::string(513,'a')));
  std::cout << "WSS configuration tests passed\n";
}
