/*
 * SPDX-FileCopyrightText: 2026 M5Stack Technology CO LTD
 *
 * SPDX-License-Identifier: MIT
 */
#include <Arduino.h>
#include <M5StackChan.h>

void setup()
{
    /* Init StackChan */
    M5StackChan.begin();

    /* Setup display */
    M5StackChan.Display().setTextSize(2);
    M5StackChan.Display().setTextScroll(true);
    M5StackChan.Display().setTextColor(TFT_YELLOW);
    M5StackChan.Display().printf("> Touch or swipe the top\n");
    M5StackChan.Display().setTextColor(TFT_GREENYELLOW);
}

void loop()
{
    /* Update touch sensor */
    M5StackChan.update();

    auto& ts = M5StackChan.TouchSensor;

    if (ts.wasClicked()) {
        M5StackChan.Display().printf("> Was clicked\n");
    }

    if (ts.wasSwipedForward()) {
        M5StackChan.Display().printf("> Was swiped forward\n");
    }

    if (ts.wasSwipedBackward()) {
        M5StackChan.Display().printf("> Was swiped backward\n");
    }

    delay(50);
}
