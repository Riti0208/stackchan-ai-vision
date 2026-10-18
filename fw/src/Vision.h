#pragma once
#include <Arduino.h>
#include <esp_camera.h>
namespace stackchan_fw {
void initVision();
bool frameDue(uint32_t now);
void encodeFrame(camera_fb_t* fb,uint32_t now);
void adaptVision(uint32_t now);
}
