/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include <Arduino.h>
#include <M5StackChan.h>

namespace {

constexpr uint16_t kBackgroundColor          = TFT_BLACK;
constexpr uint16_t kBorderColor              = TFT_WHITE;
constexpr uint16_t kTopButtonColor           = 0x39C7;
constexpr uint16_t kTopButtonPressedColor    = 0x2204;
constexpr uint16_t kBottomButtonColor        = 0x03EF;
constexpr uint16_t kBottomButtonPressedColor = 0x01E8;
constexpr uint16_t kTextColor                = TFT_WHITE;

enum class ButtonZone {
    None,
    SetHome,
    GoHome,
};

ButtonZone pressed_zone = ButtonZone::None;

ButtonZone getButtonZone(const int16_t y, const int16_t height)
{
    return y < (height / 2) ? ButtonZone::SetHome : ButtonZone::GoHome;
}

void drawButton(const int16_t x, const int16_t y, const int16_t w, const int16_t h, const uint16_t color,
                const char* line_1, const char* line_2)
{
    auto& display = M5StackChan.Display();

    display.fillRect(x, y, w, h, color);
    display.drawRect(x, y, w, h, kBorderColor);

    display.setTextDatum(middle_center);
    display.setTextColor(kTextColor, color);
    display.setTextSize(2);
    display.drawString(line_1, x + w / 2, y + h / 2 - 12);
    display.drawString(line_2, x + w / 2, y + h / 2 + 12);
}

void drawUi(ButtonZone active_zone)
{
    auto& display          = M5StackChan.Display();
    const int16_t width    = display.width();
    const int16_t height   = display.height();
    const int16_t gap      = 8;
    const int16_t button_x = 8;
    const int16_t button_w = width - button_x * 2;
    const int16_t half_h   = (height - gap) / 2;

    display.startWrite();
    display.fillScreen(kBackgroundColor);
    display.fillRect(0, half_h, width, gap, kBackgroundColor);

    drawButton(button_x, 8, button_w, half_h - 12,
               active_zone == ButtonZone::SetHome ? kTopButtonPressedColor : kTopButtonColor, "set current postion",
               "as home");

    drawButton(button_x, half_h + gap + 4, button_w, height - (half_h + gap + 12),
               active_zone == ButtonZone::GoHome ? kBottomButtonPressedColor : kBottomButtonColor, "move to", "home");

    display.endWrite();
}

}  // namespace

void setup()
{
    /* Init StackChan */
    M5StackChan.begin();

    /* Setup display */
    M5StackChan.Display().setTextScroll(false);
    drawUi(ButtonZone::None);
}

void loop()
{
    M5StackChan.update();
    auto& display               = M5StackChan.Display();
    const int16_t screen_height = display.height();
    int16_t touch_x             = 0;
    int16_t touch_y             = 0;
    const bool touching         = display.getTouch(&touch_x, &touch_y);

    if (touching) {
        const ButtonZone current_zone = getButtonZone(touch_y, screen_height);
        if (current_zone != pressed_zone) {
            pressed_zone = current_zone;
            drawUi(pressed_zone);
        }
    } else if (pressed_zone != ButtonZone::None) {
        const ButtonZone released_zone = pressed_zone;
        pressed_zone                   = ButtonZone::None;
        drawUi(ButtonZone::None);

        if (released_zone == ButtonZone::SetHome) {
            M5StackChan.Motion.setCurrentPostionAsHome();
        } else if (released_zone == ButtonZone::GoHome) {
            M5StackChan.Motion.goHome();
        }
    }

    delay(16);
}
