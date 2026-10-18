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
    M5StackChan.Display().setTextColor(TFT_GREENYELLOW);
    M5StackChan.Display().setTextScroll(true);
}

void loop()
{
    /* Get battery info from INA226 */
    float voltage = M5StackChan.getBatteryVoltage();
    float current = M5StackChan.getBatteryCurrent() * 1000;

    M5StackChan.Display().printf("> Bat: %0.2fV %0.2fmA\n", voltage, current);

    delay(1000);
}
